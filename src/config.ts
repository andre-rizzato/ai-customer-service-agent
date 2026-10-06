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
// Azure Key Vault: usado só quando KEY_VAULT_ENABLED=true no ambiente, para
// buscar os segredos (chaves de API, tokens) de lá em vez do .env local.
// DefaultAzureCredential tenta, em ordem, Managed Identity (quando rodando
// numa VM/recurso Azure configurado para isso — o caso da VM de produção),
// depois credenciais do `az login` (o caso do ambiente local de dev) — por
// isso o mesmo código funciona nos dois ambientes sem configuração extra.
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

// Preâmbulo: AgentConfigSchema descreve a FORMA esperada do arquivo
// config/agent.config.json — ou seja, tudo que é "configurável por
// negócio/cliente" (Fase 0 do runbook: nome, tom de voz, gatilhos de
// handoff) e não muda entre deploys da mesma instância do agente.
// Cada campo abaixo tem um comentário dizendo para que ele é usado e em
// qual outro módulo ele é consumido.
// Exportado (em vez de interno ao módulo) porque src/server.ts reusa este
// MESMO schema pra validar o payload de POST /api/config — nunca confiar em
// dados vindos do browser sem passar pela mesma validação que já protege a
// leitura do arquivo em disco.
export const AgentConfigSchema = z.object({
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
  // "telegram" (05/10/2026) avisa os atendentes de HANDOFF_TELEGRAM_CHAT_IDS
  // pelo bot do Telegram E permite responder ao cliente dali mesmo (relay —
  // ver src/handoffNotifier/telegramNotifier.ts e src/handoff/relay.ts).
  handoffNotifier: z.enum(["console", "webhook", "telegram"]).default("console"),

  // Quais capacidades além de RAG este cliente contratou — ver "Mapa de
  // Capacidades" (docs/artifacts/mapa-capacidades.html): cada uma vira uma
  // tela de configuração + um item de precificação. "order" é a única com
  // um backend de verdade hoje (AgentService, ver agentServiceUrl abaixo);
  // "scheduling"/"sales" já são detectadas pelo capabilityRouter mas ainda
  // caem em handoff (ver orchestrator.ts) até ganharem conector real do
  // lado do AgentService. Handoff para humano NUNCA é uma capacidade
  // desligável por aqui — é a rede de segurança do produto inteiro, não um
  // item de plano.
  enabledCapabilities: z.array(z.enum(["order", "scheduling", "sales"])).default([]),
  // Palavras/frases que, se aparecerem na mensagem, indicam pergunta sobre
  // um pedido já feito ("status do meu pedido", "cancelar pedido 123") —
  // checadas por capabilityRouter.ts SÓ quando "order" está em
  // enabledCapabilities acima. Mesma técnica e mesmo motivo de
  // handoffKeywords/frustrationKeywords: palavra-chave é mais barato e mais
  // previsível do que pedir pro LLM decidir "isso é pergunta de pedido?".
  orderKeywords: z.array(z.string()).default([]),
  schedulingKeywords: z.array(z.string()).default([]),
  salesKeywords: z.array(z.string()).default([]),

  // Quantas horas uma conversa fica "em atendimento humano" (bot
  // silenciado, ver src/orchestrator/handoffState.ts) antes de o bot
  // voltar sozinho a responder — rede de segurança pro caso de um
  // atendente esquecer de liberar a conversa manualmente (ver
  // scripts/releaseHandoff.ts). Adicionado na revisão de segurança de
  // 04/10/2026 (docs/SECURITY_REVIEW.md item #5). Default de 4h: tempo
  // generoso pra um atendimento humano real, mas curto o suficiente pra
  // não deixar um cliente sem resposta nenhuma por dias.
  handoffTimeoutHours: z.number().positive().default(4),

  // Minutos SEM NENHUMA mensagem (nem do cliente, nem do atendente) até o
  // atendimento humano ser encerrado automaticamente, com aviso ao cliente e
  // ao atendente (05/10/2026, ver HumanRelay.closeInactive()). Diferente de
  // handoffTimeoutHours acima, que cobre "o atendente sumiu" e devolve ao bot
  // em silêncio — este cobre "a conversa morreu". 0 desliga. Default de 30
  // min: tempo de sobra pra um cliente ir buscar um número de pedido, curto o
  // bastante pra não deixar atendimentos fantasmas abertos.
  handoffInactivityMinutes: z.number().min(0).default(30),

  // Controles de geração do LLM, expostos na tela de configuração
  // (public/settings.html) — "o máximo configurável possível" pedido junto
  // com essa tela. Ficam aqui (config de negócio) e não no .env porque não
  // são segredo nem infra: são comportamento do bot, do mesmo jeito que
  // toneAdjectives/minRelevanceScore. temperature controla aleatoriedade da
  // resposta (0 = sempre a resposta mais provável, 1 = mais variada);
  // maxTokens limita o tamanho máximo de uma resposta gerada. Lidos por
  // src/orchestrator/orchestrator.ts a cada mensagem (não capturados uma
  // única vez em nenhum construtor), então mudar e salvar pela tela
  // atualiza o comportamento sem reiniciar o processo.
  temperature: z.number().min(0).max(1).default(0.7),
  maxTokens: z.number().int().positive().default(1024),
});

// Tipo TypeScript derivado do schema acima — z.infer lê a definição do zod
// e gera o tipo estático correspondente, então nunca ficam dessincronizados.
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// Preâmbulo: loadAgentConfig lê o arquivo agent.config.json do disco e
// devolve um objeto já validado e tipado. É chamada uma única vez, abaixo,
// para preencher a constante exportada `agentConfig` — nenhum outro módulo
// deveria chamar esta função diretamente.
// Caminho resolvido do agent.config.json, calculado uma vez e reexportado —
// src/server.ts reaproveita EXATAMENTE este valor na rota POST /api/config
// (tela de configuração) pra gravar no mesmo arquivo que loadAgentConfig()
// lê, em vez de duplicar a regra "AGENT_CONFIG_PATH ?? default" num segundo
// lugar que poderia divergir dela.
export const agentConfigPath = resolve(process.env.AGENT_CONFIG_PATH ?? "./config/agent.config.json");

function loadAgentConfig(): AgentConfig {
  // Lê o conteúdo bruto do arquivo como texto UTF-8.
  const raw = readFileSync(agentConfigPath, "utf-8");
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

  // Bot do ATENDENTE separado do bot de clientes (06/10/2026, ver
  // src/handoff/attendants.ts): TELEGRAM_BOT_TOKEN fica só pra clientes
  // (simula o atendimento que será pelo WhatsApp) e este bot recebe os
  // alertas de handoff e as respostas do atendente, no webhook
  // /webhook/telegram-desk. Opcional: sem ele, um bot só faz as duas coisas
  // (comportamento anterior). O segredo do webhook dele cai no
  // TELEGRAM_WEBHOOK_SECRET se não for definido.
  HANDOFF_TELEGRAM_BOT_TOKEN: z.string().optional(),
  HANDOFF_TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  // Credenciais do canal WhatsApp (Meta Cloud API) — usadas por
  // src/channels/whatsapp.ts, mesma lógica de habilitação dinâmica.
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  // "App Secret" do app no Meta for Developers (Configurações do app →
  // Básico) — NÃO é o mesmo valor que WHATSAPP_ACCESS_TOKEN. Usado só para
  // validar a assinatura HMAC-SHA256 (header X-Hub-Signature-256) de cada
  // POST recebido em /webhook/whatsapp — ver src/channels/whatsapp.ts
  // verifySignature(). Antes da revisão de segurança de 04/10/2026
  // (docs/SECURITY_REVIEW.md item #3), o único "segredo" do lado de
  // recepção era o WHATSAPP_VERIFY_TOKEN, que só protege o handshake
  // ÚNICO de registro do webhook — não cada mensagem individual.
  WHATSAPP_APP_SECRET: z.string().optional(),

  // URL para onde o WebhookNotifier faz POST quando um handoff dispara
  // (ex.: Incoming Webhook do Slack). Só é obrigatória se
  // agentConfig.handoffNotifier === "webhook" (checado abaixo).
  HANDOFF_WEBHOOK_URL: z.string().optional(),

  // Chat ids do Telegram (separados por vírgula) dos ATENDENTES — quem
  // recebe o alerta de handoff quando agentConfig.handoffNotifier ===
  // "telegram", e os ÚNICOS autorizados a responder clientes pelo relay
  // (reply no Telegram ou Mini App). Mensagens desses chats ao bot nunca
  // passam pelo Orchestrator como se fossem de cliente (ver
  // TelegramAdapter.handleWebhook). Pra descobrir o seu: mande /meuid pro
  // bot. Lido por src/handoff/attendants.ts.
  HANDOFF_TELEGRAM_CHAT_IDS: z.string().optional(),

  // URL pública HTTPS deste servidor (ex.:
  // "https://rizzato-tech.rizzatotech.com"), sem barra no final — usada só
  // pra montar o link do Mini App (public/handoff-app.html) no botão
  // "Abrir conversa" do alerta. Opcional: sem ela o alerta sai sem esse
  // botão, e o atendente responde só por reply (caminho principal). O
  // Telegram exige https pra Mini App — http é ignorado.
  PUBLIC_BASE_URL: z.string().optional(),

  // Diretório onde o histórico de cada conversa é persistido em disco
  // (um arquivo .json por conversationId) — usado por
  // src/conversation/store.ts.
  CONVERSATIONS_DIR: z.string().default("./data/conversations"),
  // Arquivo de log de auditoria, formato JSON Lines (uma linha = um turno)
  // — também escrito por src/conversation/store.ts, e é o arquivo que a
  // Fase 7 do runbook recomenda ler semanalmente.
  AUDIT_LOG_PATH: z.string().default("./data/audit-log.jsonl"),

  // Se true, os segredos listados em SECRET_ENV_VARS (abaixo) são buscados
  // no Azure Key Vault em vez de lidos do .env local — ver
  // loadSecretsFromKeyVault(). Default false: comportamento idêntico ao
  // projeto original, lendo tudo do .env.
  KEY_VAULT_ENABLED: z.coerce.boolean().default(false),
  // Nome do Key Vault (não a URL completa) — obrigatório quando
  // KEY_VAULT_ENABLED=true, checado em loadSecretsFromKeyVault().
  KEY_VAULT_NAME: z.string().optional(),

  // URL base do AgentService (Python/FastAPI, standalone — ver
  // DistributedOrderSystem/src/AgentService) — obrigatória quando "order"
  // está em agentConfig.enabledCapabilities (checado mais abaixo). Esse
  // serviço é quem de fato consulta o backend de pedidos do cliente; este
  // processo Node só decide SE uma mensagem deve ir pra lá
  // (capabilityRouter.ts) e repassa a resposta.
  AGENT_SERVICE_URL: z.string().optional(),

  // Lista de origens (separadas por vírgula, ex.:
  // "https://site-do-cliente.com,https://outro-dominio.com") autorizadas a
  // chamar /webhook/web via browser vindo de FORA deste domínio — é o que
  // transforma o canal "web" (hoje só testado localmente via whatsapp.html,
  // mesmo origin) num widget embarcável de verdade no site de um cliente
  // (ver docs/artifacts/widget-embarcavel.html). Lido em src/server.ts, que
  // monta o middleware de CORS só nessa rota. Vazio/ausente = nenhuma
  // origem externa permitida (comportamento de hoje: só mesmo-origin
  // funciona, como o whatsapp.html local já faz).
  WIDGET_ALLOWED_ORIGINS: z.string().optional(),
});

// Tipo TypeScript derivado do schema de ambiente, mesmo raciocínio do
// AgentConfig acima.
export type Env = z.infer<typeof EnvSchema>;

// Preâmbulo: loadEnv valida process.env (já populado pelo `import
// "dotenv/config"` no topo do arquivo, e por loadSecretsFromKeyVault() logo
// abaixo quando KEY_VAULT_ENABLED=true) contra o EnvSchema. Chamada uma
// única vez para preencher a constante exportada `env`.
function loadEnv(): Env {
  // process.env tem tipo Record<string, string | undefined> no Node; o zod
  // aplica coerção/validação e devolve um objeto fortemente tipado conforme
  // Env, além de aplicar os valores .default(...) onde a variável não foi
  // definida.
  return EnvSchema.parse(process.env);
}

// Mapa das variáveis de ambiente consideradas SEGREDO (credenciais/tokens) —
// as únicas buscadas no Key Vault. Configuração não-secreta (PORT,
// LLM_PROVIDER, nomes de modelo, caminhos de armazenamento etc.) continua
// vindo sempre do .env/ambiente local, com ou sem Key Vault habilitado.
// Nomes de secret no Key Vault só aceitam letras, números e hífen — daí a
// conversão SNAKE_CASE -> kebab-case abaixo.
const SECRET_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "VOYAGE_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "HANDOFF_TELEGRAM_BOT_TOKEN",
  "HANDOFF_TELEGRAM_WEBHOOK_SECRET",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
  "HANDOFF_WEBHOOK_URL",
] as const;

function toKeyVaultSecretName(envVar: string): string {
  return envVar.toLowerCase().replaceAll("_", "-");
}

// Preâmbulo: quando KEY_VAULT_ENABLED=true, busca cada variável de
// SECRET_ENV_VARS no Azure Key Vault e sobrescreve process.env com o valor
// encontrado, ANTES de loadEnv() validar o ambiente — por isso é chamada
// (com await no nível do módulo, abaixo) antes de `export const env =
// loadEnv()`. Um segredo ausente no Key Vault (404) é tratado como "não
// configurado" e simplesmente não sobrescreve o que já está em
// process.env (mesmo comportamento de um .env com a chave vazia/faltando);
// qualquer outro erro (auth, rede, permissão) propaga e derruba a
// inicialização — preferível a subir o processo com metade dos segredos.
async function loadSecretsFromKeyVault(): Promise<void> {
  const vaultName = process.env.KEY_VAULT_NAME;
  if (!vaultName) {
    throw new Error(
      "KEY_VAULT_ENABLED=true mas KEY_VAULT_NAME não está definido no ambiente."
    );
  }

  const client = new SecretClient(
    `https://${vaultName}.vault.azure.net`,
    new DefaultAzureCredential()
  );

  for (const envVar of SECRET_ENV_VARS) {
    try {
      const secret = await client.getSecret(toKeyVaultSecretName(envVar));
      if (secret.value) {
        process.env[envVar] = secret.value;
      }
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404) {
        continue;
      }
      throw new Error(
        `Falha ao buscar o segredo "${toKeyVaultSecretName(envVar)}" no Key Vault "${vaultName}": ${(err as Error).message}`
      );
    }
  }
}

// Top-level await: suportado porque o projeto roda como ESM (package.json
// "type": "module", tsconfig "module": "NodeNext"). Decide, antes de
// qualquer outro módulo poder importar `env`, se busca os segredos no Key
// Vault — lendo process.env.KEY_VAULT_ENABLED diretamente (em vez de
// esperar o `env` já validado) porque loadEnv() só roda depois.
if (/^true$/i.test(process.env.KEY_VAULT_ENABLED ?? "")) {
  await loadSecretsFromKeyVault();
}

// Executa a validação de ambiente imediatamente na importação deste módulo
// e exporta o resultado — todo módulo do projeto que precisar de uma
// variável de ambiente importa `env` daqui em vez de ler process.env direto.
export const env = loadEnv();
// Mesma ideia para a configuração do negócio.
export const agentConfig = loadAgentConfig();

// Preâmbulo: validateCrossConfig() checa consistência entre agentConfig e
// env que o zod sozinho não consegue expressar (depende dos dois arquivos
// ao mesmo tempo). Extraída como função exportada — em vez de só um bloco
// solto no load do módulo — porque src/server.ts reusa EXATAMENTE esta
// mesma checagem na rota POST /api/config (tela de configuração): uma
// mudança salva pela tela que deixaria o processo nesse estado inconsistente
// tem que ser rejeitada ali, não só detectada no próximo restart.
export function validateCrossConfig(config: AgentConfig): void {
  // Se o negócio pediu notificação de handoff via webhook, o endereço desse
  // webhook TEM que existir no ambiente — sem isso o handoff dispararia e a
  // notificação falharia silenciosamente em produção, que é pior do que
  // falhar já na inicialização do processo (ou, no caso da tela, recusar o
  // save).
  if (config.handoffNotifier === "webhook" && !env.HANDOFF_WEBHOOK_URL) {
    throw new Error(
      "handoffNotifier=webhook mas HANDOFF_WEBHOOK_URL não está definido no ambiente (.env)."
    );
  }

  // Notificação pelo Telegram precisa do bot (token) e de pelo menos um
  // atendente pra avisar — sem isso o handoff dispararia, o cliente
  // ouviria "vou te conectar com um atendente" e ninguém seria avisado.
  // O token que importa é o do bot do ATENDENTE (o próprio, ou o de
  // clientes quando é um bot só — 06/10/2026).
  if (
    config.handoffNotifier === "telegram" &&
    (!(env.HANDOFF_TELEGRAM_BOT_TOKEN ?? env.TELEGRAM_BOT_TOKEN) || !env.HANDOFF_TELEGRAM_CHAT_IDS)
  ) {
    throw new Error(
      "handoffNotifier=telegram mas nenhum token de bot (HANDOFF_TELEGRAM_BOT_TOKEN ou TELEGRAM_BOT_TOKEN) e/ou HANDOFF_TELEGRAM_CHAT_IDS está definido no ambiente (.env)."
    );
  }

  // Mesmo raciocínio: "order" habilitado sem AGENT_SERVICE_URL configurado
  // significa que toda pergunta de pedido cairia num erro de rede em tempo de
  // resposta, em produção, pro primeiro cliente real que perguntasse — melhor
  // recusar o estado do que descobrir isso ao vivo.
  if (config.enabledCapabilities.includes("order") && !env.AGENT_SERVICE_URL) {
    throw new Error(
      'enabledCapabilities inclui "order" mas AGENT_SERVICE_URL não está definido no ambiente (.env).'
    );
  }
}

validateCrossConfig(agentConfig);

// Revisão de segurança 04/10/2026, item #3: se o canal WhatsApp está
// configurado (token de acesso presente — mesma condição que
// createWhatsAppAdapter() usa pra habilitar o canal), WHATSAPP_APP_SECRET
// TEM que estar presente também, senão o processo sobe aceitando POST de
// qualquer um que descubra a URL do webhook, sem validar que a requisição
// veio mesmo da Meta — preferível recusar o boot a rodar em produção sem
// essa proteção.
if (env.WHATSAPP_ACCESS_TOKEN && !env.WHATSAPP_APP_SECRET) {
  throw new Error(
    "WHATSAPP_ACCESS_TOKEN está definido mas WHATSAPP_APP_SECRET não — obrigatório para validar a assinatura de cada webhook recebido (ver docs/SECURITY_REVIEW.md item #3)."
  );
}

// Relay de handoff (05/10/2026): se existem atendentes configurados, uma
// mensagem que chega em /webhook/telegram vinda do chat id de um atendente
// é tratada como RESPOSTA A UM CLIENTE (ver src/handoff/telegramDesk.ts).
// Sem TELEGRAM_WEBHOOK_SECRET, qualquer um que descobrisse a URL do
// webhook poderia forjar um update "do atendente" e mandar mensagens pros
// clientes em nome da empresa — mesmo raciocínio do WHATSAPP_APP_SECRET
// acima: recusar o boot é melhor do que rodar sem essa proteção.
// Com bot do atendente separado (06/10/2026), o webhook que importa é o
// dele — vale o segredo próprio ou, na falta, o do bot de clientes.
if (env.HANDOFF_TELEGRAM_CHAT_IDS && !(env.HANDOFF_TELEGRAM_WEBHOOK_SECRET ?? env.TELEGRAM_WEBHOOK_SECRET)) {
  throw new Error(
    "HANDOFF_TELEGRAM_CHAT_IDS está definido mas nenhum segredo de webhook (HANDOFF_TELEGRAM_WEBHOOK_SECRET ou TELEGRAM_WEBHOOK_SECRET) — obrigatório pra que ninguém consiga forjar uma resposta de atendente pelo webhook do Telegram."
  );
}

// Nota de design: as chaves de API de LLM/embeddings (ANTHROPIC_API_KEY,
// OPENAI_API_KEY, VOYAGE_API_KEY) são validadas sob demanda, dentro de
// createLLMProvider() (src/llm/index.ts) e createEmbeddingProvider()
// (src/embeddings/index.ts) — e não aqui. Se validássemos aqui, qualquer
// módulo que apenas importe `agentConfig`/`env` (inclusive testes unitários
// de peças que não chamam nenhuma API, como o detector de handoff) seria
// obrigado a ter TODAS as credenciais presentes só para poder rodar.
