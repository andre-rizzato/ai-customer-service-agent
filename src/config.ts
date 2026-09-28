// Ponto único de carregamento e validação de configuração do agente.
// Todo outro módulo do projeto importa `env` e/ou `agentConfig` DAQUI em vez
// de ler process.env ou arquivos JSON diretamente — assim garantimos que
// existe só um lugar onde a forma dos dados é validada (com zod) e só um
// lugar para mudar se um novo campo de configuração for adicionado.

// readFileSync: lê o arquivo de configuração do negócio (agent.config.json)
// de forma síncrona — síncrono é aceitável aqui porque isso roda uma única
// vez, na inicialização do processo, antes de qualquer request chegar.
import { readFileSync } from "node:fs";
// resolve: transforma o caminho relativo/absoluto vindo do .env ou do valor
// default em um caminho absoluto, para não depender de qual é o cwd de onde
// o processo Node foi iniciado (dev vs. produção podem diferir).
import { resolve } from "node:path";
// "dotenv/config" é um import "por efeito colateral": ao ser importado, a
// própria lib lê o arquivo .env da raiz do projeto e injeta cada chave em
// process.env. Precisa ser importado ANTES de lermos process.env abaixo.
import "dotenv/config";
// zod: biblioteca de validação de esquema. Usamos para dois propósitos:
// (1) falhar rápido e com mensagem clara se agent.config.json ou o .env
// estiverem incompletos/errados, em vez de quebrar silenciosamente depois
// no meio de uma conversa; (2) derivar os tipos TypeScript automaticamente
// a partir do schema, para não manter tipo e validação em dois lugares.
import { z } from "zod";

// Preâmbulo: AgentConfigSchema descreve a FORMA esperada do arquivo
// config/agent.config.json — ou seja, tudo que é "configurável por
// negócio/cliente" (Fase 0 do runbook: nome, tom de voz, gatilhos de
// handoff) e não muda entre deploys da mesma instância do agente.
// Cada campo abaixo tem um comentário dizendo para que ele é usado e em
// qual outro módulo ele é consumido.
const AgentConfigSchema = z.object({
  // Nome do negócio, injetado no prompt (promptBuilder.ts) tanto na frase de
  // abertura ("Você é o assistente virtual de X") quanto na regra de
  // transparência ("Sou um assistente virtual de X").
  businessName: z.string().min(1),
  // Lista de adjetivos que descrevem o tom de voz (Fase 0: "grave o
  // histórico de conversas reais" para definir isso). Injetados literalmente
  // na seção TOM do prompt.
  toneAdjectives: z.array(z.string()).min(1),
  // Caminho do arquivo JSON com o catálogo (Fase 3 "Catalogar") — lido pelo
  // script de ingest (src/knowledge/ingest.ts), nunca em tempo de resposta.
  knowledgeBasePath: z.string().min(1),
  // Caminho onde o índice vetorial fica persistido em disco — usado tanto
  // pelo ingest (grava) quanto pelo KnowledgeBase (lê) em
  // src/knowledge/vectorStore.ts.
  vectorStorePath: z.string().min(1),
  // Quantos trechos da base recuperar por pergunta (top-K da busca por
  // similaridade). .default(3) é aplicado pelo zod se o campo faltar no JSON.
  topK: z.number().int().positive().default(3),
  // Nota de corte de similaridade (0 a 1): trechos abaixo disso são
  // descartados antes de irem para o prompt — é a "regra de vazio" da Fase 3
  // aplicada em src/knowledge/knowledgeBase.ts.
  minRelevanceScore: z.number().min(0).max(1).default(0.7),
  // Palavras/frases que, se aparecerem na mensagem do usuário, disparam
  // handoff imediato por pedido explícito — checado em
  // src/orchestrator/handoff.ts ANTES de chamar o LLM.
  handoffKeywords: z.array(z.string()).default([]),
  // Mesma ideia, mas para sinais de frustração/reclamação (terceiro gatilho
  // de handoff da Fase 1/4 do runbook).
  frustrationKeywords: z.array(z.string()).default([]),
  // Configuração do rate limiter (Fase 6: "evitar custo descontrolado em
  // caso de mensagens em loop"), consumida por
  // src/orchestrator/rateLimiter.ts.
  rateLimit: z.object({
    maxMessagesPerWindow: z.number().int().positive(),
    windowSeconds: z.number().int().positive(),
  }),
  // Qual implementação de HandoffNotifier usar quando um handoff dispara —
  // "console" só loga no terminal (bom para dev), "webhook" faz POST em
  // HANDOFF_WEBHOOK_URL (Fase 6: "alerta automático e-mail ou Slack").
  handoffNotifier: z.enum(["console", "webhook"]).default("console"),
});

// Tipo TypeScript derivado do schema acima — z.infer lê a definição do zod
// e gera o tipo estático correspondente, então nunca ficam dessincronizados.
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// Preâmbulo: loadAgentConfig lê o arquivo agent.config.json do disco e
// devolve um objeto já validado e tipado. É chamada uma única vez, abaixo,
// para preencher a constante exportada `agentConfig` — nenhum outro módulo
// deveria chamar esta função diretamente.
function loadAgentConfig(): AgentConfig {
  // Permite trocar o caminho do config via variável de ambiente
  // AGENT_CONFIG_PATH (usado pelos testes, que apontam para o arquivo
  // .example.json em vez do config real do negócio); se não setado, cai no
  // caminho padrão de produção.
  const path = process.env.AGENT_CONFIG_PATH ?? "./config/agent.config.json";
  // Lê o conteúdo bruto do arquivo como texto UTF-8.
  const raw = readFileSync(resolve(path), "utf-8");
  // JSON.parse converte o texto em objeto JS; AgentConfigSchema.parse valida
  // esse objeto contra o schema acima e LANÇA uma exceção detalhada se algo
  // estiver faltando ou com tipo errado — preferível a descobrir isso só
  // quando uma conversa real cair num campo undefined.
  return AgentConfigSchema.parse(JSON.parse(raw));
}

// Preâmbulo: EnvSchema descreve TODAS as variáveis de ambiente que o
// processo pode usar — credenciais de API, tokens de canal, caminhos de
// armazenamento local. Diferente do AgentConfig (que é "configuração do
// negócio", versionável e comum entre ambientes), isto é "segredo/ambiente"
// e vive no .env, que nunca deve ser commitado (ver .gitignore).
const EnvSchema = z.object({
  // Porta HTTP do servidor Express (src/server.ts). z.coerce.number()
  // converte a string do ambiente ("3000") em number antes de validar.
  PORT: z.coerce.number().int().positive().default(3000),

  // Qual provedor de LLM usar — lido por src/llm/index.ts para decidir se
  // instancia AnthropicProvider ou OpenAIProvider.
  LLM_PROVIDER: z.enum(["anthropic", "openai"]).default("anthropic"),
  // Chave da API da Anthropic. .optional() porque só é obrigatória quando
  // LLM_PROVIDER=anthropic — essa checagem condicional é feita em
  // createLLMProvider(), não aqui (ver comentário no fim do arquivo).
  ANTHROPIC_API_KEY: z.string().optional(),
  // Modelo Claude específico a usar; tem um default sensato para não
  // obrigar configuração extra em um MVP.
  ANTHROPIC_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  // Mesma lógica do par acima, mas para a OpenAI.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),

  // Qual provedor de EMBEDDINGS usar para o RAG — independente do
  // LLM_PROVIDER, porque a Anthropic não tem endpoint de embeddings; Voyage
  // AI é o parceiro recomendado pela própria Anthropic para isso, por isso
  // é o default.
  EMBEDDING_PROVIDER: z.enum(["voyage", "openai", "local"]).default("voyage"),
  VOYAGE_API_KEY: z.string().optional(),
  VOYAGE_MODEL: z.string().default("voyage-3.5-lite"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),

  // Credenciais do canal Telegram — usadas por src/channels/telegram.ts.
  // Ambas opcionais porque o canal é habilitado dinamicamente: se
  // TELEGRAM_BOT_TOKEN não estiver setado, src/server.ts simplesmente não
  // monta esse adapter (ver createTelegramAdapter).
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  // Credenciais do canal WhatsApp (Meta Cloud API) — usadas por
  // src/channels/whatsapp.ts, mesma lógica de habilitação dinâmica.
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),

  // URL para onde o WebhookNotifier faz POST quando um handoff dispara
  // (ex.: Incoming Webhook do Slack). Só é obrigatória se
  // agentConfig.handoffNotifier === "webhook" (checado abaixo).
  HANDOFF_WEBHOOK_URL: z.string().optional(),

  // Diretório onde o histórico de cada conversa é persistido em disco
  // (um arquivo .json por conversationId) — usado por
  // src/conversation/store.ts.
  CONVERSATIONS_DIR: z.string().default("./data/conversations"),
  // Arquivo de log de auditoria, formato JSON Lines (uma linha = um turno)
  // — também escrito por src/conversation/store.ts, e é o arquivo que a
  // Fase 7 do runbook recomenda ler semanalmente.
  AUDIT_LOG_PATH: z.string().default("./data/audit-log.jsonl"),
});

// Tipo TypeScript derivado do schema de ambiente, mesmo raciocínio do
// AgentConfig acima.
export type Env = z.infer<typeof EnvSchema>;

// Preâmbulo: loadEnv valida process.env (já populado pelo `import
// "dotenv/config"` no topo do arquivo) contra o EnvSchema. Chamada uma
// única vez para preencher a constante exportada `env`.
function loadEnv(): Env {
  // process.env tem tipo Record<string, string | undefined> no Node; o zod
  // aplica coerção/validação e devolve um objeto fortemente tipado conforme
  // Env, além de aplicar os valores .default(...) onde a variável não foi
  // definida.
  return EnvSchema.parse(process.env);
}

// Executa a validação de ambiente imediatamente na importação deste módulo
// e exporta o resultado — todo módulo do projeto que precisar de uma
// variável de ambiente importa `env` daqui em vez de ler process.env direto.
export const env = loadEnv();
// Mesma ideia para a configuração do negócio.
export const agentConfig = loadAgentConfig();

// Checagem de consistência cruzada entre os dois arquivos de configuração:
// se o negócio pediu notificação de handoff via webhook, o endereço desse
// webhook TEM que existir no ambiente — sem isso o handoff dispararia e a
// notificação falharia silenciosamente em produção, que é pior do que
// falhar já na inicialização do processo.
if (agentConfig.handoffNotifier === "webhook" && !env.HANDOFF_WEBHOOK_URL) {
  throw new Error(
    "agent.config.json sets handoffNotifier=webhook but HANDOFF_WEBHOOK_URL is not set in the environment."
  );
}

// Nota de design: as chaves de API de LLM/embeddings (ANTHROPIC_API_KEY,
// OPENAI_API_KEY, VOYAGE_API_KEY) são validadas sob demanda, dentro de
// createLLMProvider() (src/llm/index.ts) e createEmbeddingProvider()
// (src/embeddings/index.ts) — e não aqui. Se validássemos aqui, qualquer
// módulo que apenas importe `agentConfig`/`env` (inclusive testes unitários
// de peças que não chamam nenhuma API, como o detector de handoff) seria
// obrigado a ter TODAS as credenciais presentes só para poder rodar.
