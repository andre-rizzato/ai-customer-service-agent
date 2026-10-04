// Estado de "conversa em atendimento humano" — a peça que faltava depois da
// revisão de segurança de 04/10/2026 (item #5): até aqui, um handoff só
// disparava uma notificação (ver handoffNotifier/) e respondia uma vez; na
// PRÓXIMA mensagem do mesmo cliente, o bot voltava a responder normalmente
// por cima do atendente humano, porque nada marcava a conversa como "já
// transferida". Esta classe guarda esse estado, por conversa, em disco —
// precisa sobreviver a um restart do processo (diferente do RateLimiter,
// que é só em memória), senão um reboot da VM no meio de um atendimento
// humano faria o bot voltar sozinho sem ninguém pedir.
//
// Decisão de produto (ainda em aberto, ver docs/SECURITY_REVIEW.md item
// #5): COMO o atendente humano responde de fato ainda não está construído
// — hoje ele recebe o histórico completo via HandoffNotifier (console ou
// webhook) e continua o atendimento por fora (outro número/canal). Esta
// classe resolve só a METADE que já dava pra resolver sem essa decisão: o
// bot ficar quieto depois que avisou que ia transferir.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../config.js";

// Preâmbulo: HandoffState é o formato salvo em disco, um arquivo por
// conversa. `since` é o timestamp (epoch ms) de quando o handoff foi
// ativado — é o que permite calcular se já passou do timeout de segurança
// (ver isActive() abaixo), sem precisar de nenhum agendador/cron rodando
// em paralelo: a checagem é feita sob demanda, na próxima mensagem que
// chegar.
interface HandoffState {
  active: boolean;
  since: number;
}

// Valor usado quando o arquivo de estado ainda não existe (conversa nunca
// teve handoff) — equivalente a "nunca ativado".
const INACTIVE: HandoffState = { active: false, since: 0 };

// Preâmbulo: HandoffStateStore é instanciada uma vez pelo Orchestrator,
// com o timeout vindo de agent.config.json (agentConfig.handoffTimeoutHours
// — configurável por negócio, mesmo padrão de rateLimit/minRelevanceScore).
// Usa a MESMA pasta de CONVERSATIONS_DIR do ConversationStore, mas em uma
// subpasta própria ("handoff-state"), pra não misturar os dois tipos de
// arquivo (histórico de conversa vs. estado de handoff) no mesmo diretório.
export class HandoffStateStore {
  // Pasta onde cada conversa vira um arquivo .json próprio de estado.
  private readonly dir: string;
  // Timeout de segurança, em milissegundos — calculado uma vez no
  // construtor a partir das horas configuradas, pra não refazer a
  // multiplicação em toda chamada de isActive().
  private readonly timeoutMs: number;

  constructor(timeoutHours: number) {
    this.dir = resolve(env.CONVERSATIONS_DIR, "handoff-state");
    this.timeoutMs = timeoutHours * 60 * 60 * 1000;
    // recursive:true não falha se a pasta já existir — seguro chamar
    // sempre na inicialização, mesmo processo reiniciado.
    mkdirSync(this.dir, { recursive: true });
  }

  // Preâmbulo: filePathFor() calcula o caminho do arquivo de estado de uma
  // conversa específica — mesma lógica de sanitização do
  // ConversationStore.filePathFor() (conversationId pode vir de fonte
  // externa — número de telefone, chat id — e não é necessariamente um
  // nome de arquivo válido nem seguro contra path traversal).
  private filePathFor(conversationId: string): string {
    const safeId = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return resolve(this.dir, `${safeId}.json`);
  }

  // Preâmbulo: load() lê o estado salvo de uma conversa, ou devolve
  // INACTIVE se o arquivo não existe (conversa que nunca teve handoff).
  // Privado — só usado internamente por isActive()/activate()/release().
  private load(conversationId: string): HandoffState {
    const path = this.filePathFor(conversationId);
    if (!existsSync(path)) return INACTIVE;
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  // Preâmbulo: save() grava o estado de uma conversa em disco — sempre
  // reescreve o arquivo inteiro (ele só tem dois campos, custo
  // desprezível), mesmo padrão de simplicidade do ConversationStore.
  private save(conversationId: string, state: HandoffState): void {
    writeFileSync(this.filePathFor(conversationId), JSON.stringify(state), "utf-8");
  }

  // Preâmbulo: isActive() é chamado pelo Orchestrator no INÍCIO do
  // pipeline, antes até do rate limiter — se devolver true, o Orchestrator
  // só registra a mensagem no histórico e NÃO responde nada (ver PASSO 0
  // em orchestrator.ts). Também é responsável por liberar sozinho um
  // handoff esquecido: se já passou do timeout configurado desde a
  // ativação, chama release() e devolve false, sem precisar de nenhuma
  // ação externa.
  isActive(conversationId: string): boolean {
    const state = this.load(conversationId);
    if (!state.active) return false;

    // Timeout de segurança: evita que um atendente que esqueceu de liberar
    // a conversa deixe o cliente sem resposta do bot pra sempre — depois
    // de `timeoutMs` sem ninguém chamar release() explicitamente, o bot
    // volta a responder sozinho.
    if (Date.now() - state.since >= this.timeoutMs) {
      this.release(conversationId);
      return false;
    }

    return true;
  }

  // Preâmbulo: activate() marca uma conversa como "em atendimento humano"
  // — chamada pelo Orchestrator em TODO ponto que já dispara o
  // HandoffNotifier (gatilho por palavra-chave, falha do AgentService,
  // capacidade sem conector ainda, e a nova intenção cancel_order — ver
  // orchestrator.ts), nunca diretamente por um canal/adapter.
  activate(conversationId: string): void {
    this.save(conversationId, { active: true, since: Date.now() });
  }

  // Preâmbulo: release() limpa o estado de handoff de uma conversa,
  // devolvendo o controle pro bot. Chamada automaticamente por isActive()
  // quando o timeout expira, e manualmente pelo script
  // scripts/releaseHandoff.ts (o mecanismo "comando explícito do
  // atendente" — ver docs/SECURITY_REVIEW.md item #5) até existir uma
  // interface de verdade pra isso.
  release(conversationId: string): void {
    this.save(conversationId, INACTIVE);
  }
}
