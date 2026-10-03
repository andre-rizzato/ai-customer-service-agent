// O ORQUESTRADOR: peça central do agente, onde todas as outras peças se
// encontram. Implementa literalmente o diagrama "Fluxo de uma mensagem" da
// Fase 1 do runbook (rate limit -> gatilho de handoff -> RAG -> prompt ->
// LLM -> log -> resposta) de forma totalmente agnóstica de canal — nenhuma
// linha deste arquivo sabe se a mensagem veio do Telegram, do WhatsApp ou
// do adapter de teste "web". Cada ChannelAdapter só precisa normalizar seu
// payload específico em um InboundMessage e chamar handleMessage(); todo o
// resto (RAG, prompt, LLM, log, handoff, rate limit) é compartilhado.
import { agentConfig } from "../config.js";
import { ConversationStore } from "../conversation/store.js";
import { createHandoffNotifier, type HandoffNotifier } from "../handoffNotifier/index.js";
import { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import { createLLMProvider, type LLMProvider } from "../llm/index.js";
import type { InboundMessage } from "../types.js";
import { callAgentService } from "./agentServiceClient.js";
import { detectCapability } from "./capabilityRouter.js";
import { detectHandoffTrigger } from "./handoff.js";
import { buildSystemPrompt } from "./promptBuilder.js";
import { RateLimiter } from "./rateLimiter.js";

// Mensagem fixa enviada ao usuário sempre que um handoff dispara — fica
// como constante de módulo (em vez de string solta dentro do método) para
// ser fácil de encontrar e editar, e para não ser recriada a cada chamada.
const HANDOFF_REPLY =
  "Vou te conectar com um atendente humano para continuar essa conversa. Só um instante.";
// Mensagem fixa enviada quando o rate limiter bloqueia uma mensagem — mesmo
// raciocínio da constante acima.
const RATE_LIMIT_REPLY =
  "Recebi várias mensagens muito rápido e preciso desacelerar um pouco — me manda de novo em um minuto, por favor.";
// Mensagem fixa pra quando capabilityRouter detecta "scheduling"/"sales" —
// capacidades que já existem na tela de configuração do cliente (Mapa de
// Capacidades) mas ainda não têm conector plugado do lado do AgentService
// nesta versão. Cair em handoff aqui é deliberado: é a mesma regra
// anti-alucinação do resto do produto (promptBuilder.ts) aplicada à
// orquestração — "sem integração real, não finge que resolveu".
const CAPABILITY_NOT_WIRED_REPLY =
  "Vou te conectar com um atendente humano para resolver isso com você. Só um instante.";

// Preâmbulo: a classe Orchestrator é instanciada UMA VEZ por processo
// (ver src/server.ts e scripts/simulate.ts) e reaproveitada para todas as
// mensagens que chegam depois — por isso todas as dependências pesadas
// (conexões com provedores, índice vetorial carregado do disco) vivem como
// propriedades de instância, montadas uma única vez no construtor implícito
// (inicializadores de propriedade), em vez de recriadas a cada mensagem.
export class Orchestrator {
  // Histórico + log de auditoria (ver src/conversation/store.ts). `new
  // ConversationStore()` já garante que as pastas de dados existam.
  private readonly conversations = new ConversationStore();
  // Busca semântica no catálogo (ver src/knowledge/knowledgeBase.ts). Carrega
  // o índice vetorial do disco na construção.
  private readonly knowledgeBase = new KnowledgeBase();
  // Provedor de LLM concreto (Claude ou OpenAI), decidido pela factory a
  // partir de LLM_PROVIDER no .env — o Orchestrator só enxerga a interface
  // LLMProvider, nunca a classe concreta.
  private readonly llm: LLMProvider = createLLMProvider();
  // Notificador de handoff concreto (console ou webhook), decidido pela
  // factory a partir de agentConfig.handoffNotifier.
  private readonly handoffNotifier: HandoffNotifier = createHandoffNotifier();
  // Limitador de taxa, configurado com os limites vindos de
  // agent.config.json (rateLimit.maxMessagesPerWindow /
  // rateLimit.windowSeconds).
  private readonly rateLimiter = new RateLimiter(
    agentConfig.rateLimit.maxMessagesPerWindow,
    agentConfig.rateLimit.windowSeconds
  );

  // Preâmbulo: handleMessage() é o ÚNICO método público desta classe e o
  // ponto de entrada de todo o pipeline — é chamado por cada ChannelAdapter
  // (Telegram, WhatsApp, Web) uma vez por mensagem recebida, sempre com um
  // InboundMessage já normalizado. Devolve o texto da resposta que o
  // adapter deve enviar de volta ao usuário pelo mesmo canal.
  async handleMessage(message: InboundMessage): Promise<string> {
    // Desestrutura só os campos que este método usa; `channel` e `userId`
    // não são necessários aqui (o pipeline não ramifica por canal nem
    // precisa do userId separado do conversationId).
    const { conversationId, text, timestamp } = message;

    // PASSO 1 — Rate limit: roda antes de QUALQUER outra coisa, inclusive
    // antes de gravar a mensagem no histórico, para que uma mensagem
    // bloqueada não gaste nem uma escrita em disco além do necessário para
    // a própria checagem de limite.
    if (!this.rateLimiter.isAllowed(conversationId)) {
      return RATE_LIMIT_REPLY;
    }

    // Grava a mensagem do usuário no histórico/log ANTES de decidir o que
    // fazer com ela — assim, mesmo que um handoff dispare logo em seguida
    // e a conversa termine ali, a mensagem que causou o handoff fica
    // registrada no histórico anexado ao atendente humano.
    this.conversations.append(conversationId, { role: "user", text, timestamp });

    // PASSO 2 — Gatilho de handoff: checagem por palavra-chave (ver
    // handoff.ts), mais barata que uma chamada de RAG + LLM e determinística
    // (não depende do modelo "decidir" transferir).
    const handoffReason = detectHandoffTrigger(text);
    if (handoffReason) {
      // Recupera o histórico ATUALIZADO (já incluindo a mensagem que acabou
      // de disparar o handoff) para anexar à notificação — corresponde ao
      // requisito da Fase 1 de o atendente receber "a conversa pronta".
      const history = this.conversations.getHistory(conversationId);
      // Aguarda a notificação terminar antes de responder ao usuário; se a
      // notificação falhar, ela mesma trata o erro internamente sem lançar
      // (ver WebhookNotifier), então esta linha nunca impede a resposta
      // abaixo de ser enviada.
      await this.handoffNotifier.notify(conversationId, handoffReason, history);
      // Registra no histórico que um handoff ocorreu, como um turno de tipo
      // "system-note" — isso é só para fins de auditoria (aparece no log
      // JSONL com handoff:true), e é FILTRADO explicitamente mais abaixo
      // antes de montar o histórico enviado ao LLM (senão essa anotação
      // interna seria enviada ao modelo como se fosse fala de um dos lados
      // da conversa).
      this.conversations.append(conversationId, {
        role: "system-note",
        text: `Handoff acionado: ${handoffReason}`,
        timestamp: Date.now(),
        handoff: true,
      });
      // Encerra o pipeline aqui — não faz busca no RAG nem chama o LLM para
      // esta mensagem, exatamente como o diagrama da Fase 1 descreve
      // ("Sim -> transfere para humano" é um ramo que pula direto para o
      // fim, sem passar pela caixa de "busca na base").
      return HANDOFF_REPLY;
    }

    // PASSO 2.5 — Roteamento de capacidade: só chega aqui se não houve
    // handoff. Pergunta "essa mensagem é sobre pedido/agenda/venda?" — se
    // for e a capacidade estiver habilitada pro cliente, PULA o RAG+LLM
    // normal (que não tem como responder "qual o status do MEU pedido",
    // é dado em tempo real, não conhecimento geral do catálogo).
    const capability = detectCapability(text);
    if (capability === "order") {
      // callAgentService pode falhar por rede/timeout (AgentService fora do
      // ar, por exemplo) — degrada pra handoff em vez de propagar o erro
      // pro ChannelAdapter, mesma filosofia de "nunca deixar o usuário sem
      // resposta" do resto do pipeline.
      try {
        const agentResponse = await callAgentService(text, conversationId);
        this.conversations.append(conversationId, {
          role: "assistant",
          text: agentResponse.reply,
          timestamp: Date.now(),
          contextUsed: agentResponse.order_id ? [`order:${agentResponse.order_id}`] : [],
        });
        return agentResponse.reply;
      } catch (err) {
        console.error("AgentService call failed, falling back to handoff:", err);
        await this.handoffNotifier.notify(conversationId, "explicit_request", this.conversations.getHistory(conversationId));
        this.conversations.append(conversationId, {
          role: "system-note",
          text: "Handoff acionado: order (AgentService indisponível)",
          timestamp: Date.now(),
          handoff: true,
        });
        return HANDOFF_REPLY;
      }
    }
    if (capability === "scheduling" || capability === "sales") {
      // Capacidade habilitada e detectada, mas sem conector real ainda
      // (ver capabilityRouter.ts) — handoff honesto em vez de resposta
      // inventada, registrado do mesmo jeito que um handoff por palavra-
      // chave normal (ver PASSO 2 acima) pra aparecer igual na auditoria.
      const history = this.conversations.getHistory(conversationId);
      await this.handoffNotifier.notify(conversationId, "explicit_request", history);
      this.conversations.append(conversationId, {
        role: "system-note",
        text: `Handoff acionado: ${capability} (capacidade sem conector ainda)`,
        timestamp: Date.now(),
        handoff: true,
      });
      return CAPABILITY_NOT_WIRED_REPLY;
    }

    // PASSO 3 — Busca RAG: só chega aqui se não houve gatilho de handoff.
    // Devolve só os trechos que passaram no corte de relevância mínima
    // (ver knowledgeBase.ts) — pode vir vazio, e é isso que aciona a "regra
    // de vazio" dentro do prompt (ver promptBuilder.ts).
    const retrieved = await this.knowledgeBase.search(text);
    // PASSO 4 — Monta o system prompt com as 3 regras fixas + o contexto
    // recuperado (ou a frase de "nada encontrado").
    const systemPrompt = buildSystemPrompt(retrieved);
    // Monta o histórico no formato que o LLMProvider espera (ChatMessage[]:
    // só role "user"/"assistant" + content).
    const history = this.conversations
      .getHistory(conversationId)
      // Remove qualquer turno "system-note" (ex.: o registro de handoff
      // gravado acima em uma chamada anterior desta mesma conversa) — o
      // modelo nunca deve ver essas anotações internas como se fossem parte
      // do diálogo real entre usuário e assistente.
      .filter((turn) => turn.role !== "system-note")
      .map((turn) => ({
        // Depois do filtro acima, turn.role só pode ser "user" ou
        // "assistant" — o `as` documenta essa garantia para o TypeScript,
        // que não consegue inferir sozinho o efeito do .filter() anterior.
        role: turn.role as "user" | "assistant",
        content: turn.text,
      }));

    // PASSO 5 — Chama o LLM configurado (Claude ou OpenAI) com o system
    // prompt montado e o histórico da conversa; `generate` devolve só o
    // texto da resposta (ver LLMProvider.generate).
    const reply = await this.llm.generate(systemPrompt, history);

    // PASSO 6 — Log: grava a resposta do assistente no histórico/auditoria,
    // incluindo QUAIS itens da base foram usados para gerar essa resposta
    // (contextUsed) — é o dado que permite a auditoria manual semanal da
    // Fase 7 checar "essa resposta veio de qual trecho da base?".
    this.conversations.append(conversationId, {
      role: "assistant",
      text: reply,
      timestamp: Date.now(),
      contextUsed: retrieved.map((r) => r.item.id),
    });

    // PASSO 7 — Devolve o texto da resposta; quem chamou (o ChannelAdapter)
    // é responsável por enviá-la de volta ao usuário pelo canal de origem.
    return reply;
  }
}
