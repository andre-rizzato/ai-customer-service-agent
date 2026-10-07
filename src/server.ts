// Ponto de entrada do processo servidor: sobe um app Express, monta um
// Orchestrator, monta um ChannelAdapter por canal habilitado, e conecta
// cada adapter à sua própria rota de webhook. Este arquivo é
// deliberadamente "burro" — toda a lógica de negócio vive no Orchestrator e
// nos adapters; aqui só existe fiação (wiring).
import express from "express";
import { resolve } from "node:path";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { ZodError } from "zod";
import { AgentConfigSchema, agentConfig, agentConfigPath, env, validateCrossConfig } from "./config.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { KnowledgeBase } from "./knowledge/knowledgeBase.js";
import { createTelegramAdapter, createTelegramDeskAdapter } from "./channels/telegram.js";
import { createWhatsAppAdapter } from "./channels/whatsapp.js";
import { WebAdapter } from "./channels/web.js";
import type { ChannelAdapter } from "./channels/types.js";
import { HumanRelay, type ChannelSender } from "./handoff/relay.js";
import { TelegramDesk } from "./handoff/telegramDesk.js";
import { attendantChatIds, deskBotToken } from "./handoff/attendants.js";
import { validateTelegramInitData } from "./handoff/telegramInitData.js";
import type { ChannelName } from "./types.js";

// Augmenta o tipo Request do Express com o campo rawBody (ver o hook
// `verify` do express.json() logo abaixo) — fazer isso via "declare
// global" em vez de um cast solto em cada lugar que lê req.rawBody (ex.:
// src/channels/whatsapp.ts) dá autocomplete/checagem de tipo em todo
// módulo que precisar desse campo, e documenta num lugar só de onde ele
// vem.
declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

// Cria a aplicação Express — o framework HTTP usado para expor os webhooks.
const app = express();
// Middleware que faz o parse automático do corpo de requisições com
// Content-Type: application/json para um objeto JS acessível em req.body —
// sem isso, cada adapter teria que fazer esse parse manualmente.
//
// `verify` é um hook do express.json() chamado com os BYTES BRUTOS do
// corpo, antes do parse — guardamos eles em req.rawBody porque a
// validação de assinatura HMAC do WhatsApp (ver
// src/channels/whatsapp.ts verifySignature(), revisão de segurança de
// 04/10/2026 item #3) precisa calcular o hash sobre os bytes EXATOS que a
// Meta enviou, byte a byte — JSON.stringify(req.body) não é garantidamente
// idêntico ao corpo original (ordem de chaves, espaçamento, etc. podem
// diferir depois de um parse+serialize), então usar req.body pra validar
// assinatura seria um bug sutil que falharia a validação de requisições
// legítimas. Sem este hook, express.json() descarta os bytes brutos depois
// do parse e não haveria como recuperá-los depois.
app.use(
  express.json({
    // O tipo de `req` aqui vem do body-parser (http.IncomingMessage), não
    // de Express.Request — por isso a augmentação "declare global" acima
    // não se aplica automaticamente a este parâmetro, e o cast abaixo é
    // necessário para gravar rawBody nele. Em tempo de execução é SEMPRE
    // o mesmo objeto Request que os handlers de rota recebem depois (o
    // Express reaproveita a mesma instância do início ao fim do ciclo de
    // vida da requisição), então o cast é seguro.
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = buf;
    },
  })
);

// Serve a pasta public/ como arquivos estáticos — hoje contém só
// whatsapp.html, uma interface de teste que imita visualmente o WhatsApp e
// fala com o canal "web" (POST /webhook/web, montado mais abaixo) pelo mesmo
// origin, sem precisar de CORS. Puramente uma ferramenta de debug local; não
// faz parte do pipeline de negócio.
app.use(express.static(resolve("./public")));

// Instancia o Orchestrator UMA VEZ para todo o processo — ele por sua vez
// instancia (também uma vez) o ConversationStore, KnowledgeBase, LLMProvider
// etc., então recriar o Orchestrator a cada requisição recarregaria tudo
// isso desnecessariamente.
const orchestrator = new Orchestrator();

// Lista de adapters ativos nesta instância do servidor. O adapter "web"
// entra sempre (não depende de nenhuma credencial externa, serve para
// teste/integração simples).
const adapters: ChannelAdapter[] = [new WebAdapter()];

// createTelegramAdapter() devolve null se TELEGRAM_BOT_TOKEN não estiver
// configurado — só adiciona à lista (e portanto só monta a rota
// /webhook/telegram) se o canal estiver de fato configurado.
const telegram = createTelegramAdapter();
if (telegram) adapters.push(telegram);
else console.warn("TELEGRAM_BOT_TOKEN not set — Telegram channel disabled.");

// Mesma lógica para o WhatsApp — precisa das três credenciais configuradas
// (ver createWhatsAppAdapter em src/channels/whatsapp.ts).
const whatsapp = createWhatsAppAdapter();
if (whatsapp) adapters.push(whatsapp);
else console.warn("WHATSAPP_ACCESS_TOKEN/PHONE_NUMBER_ID/VERIFY_TOKEN/APP_SECRET not set — WhatsApp channel disabled.");

// Relay de handoff (05/10/2026, ver src/handoff/relay.ts): um "sender" por
// canal habilitado que consegue mandar mensagem proativa. `.bind()` porque
// sendMessage é método de instância e usa `this` (token, phoneNumberId) —
// passar a referência solta perderia o `this`. "web" fica de fora de
// propósito: a resposta do atendente é entregue pelo polling do widget.
const senders: Partial<Record<ChannelName, ChannelSender>> = {};
if (telegram) senders.telegram = telegram.sendMessage.bind(telegram);
if (whatsapp) senders.whatsapp = whatsapp.sendMessage.bind(whatsapp);
const relay = new HumanRelay(orchestrator, senders);

// Balcão do atendente no Telegram: só existe se o bot está configurado E há
// atendentes na allowlist. Atribuído ao adapter depois da construção (ver
// comentário em TelegramAdapter.desk sobre a dependência circular).
//
// Dois modos (06/10/2026):
//  - bot do atendente SEPARADO (HANDOFF_TELEGRAM_BOT_TOKEN): ele ganha um
//    adapter próprio em /webhook/telegram-desk, só com o balcão; o bot de
//    clientes fica sem balcão — inclusive quem é atendente é tratado como
//    CLIENTE lá, o que permite testar o atendimento pelo próprio celular.
//  - um bot só (sem HANDOFF_TELEGRAM_BOT_TOKEN): comportamento anterior, o
//    balcão vive dentro do adapter de clientes.
const telegramDesk = createTelegramDeskAdapter();
if (telegramDesk && attendantChatIds.size > 0) {
  telegramDesk.desk = new TelegramDesk(deskBotToken!, relay, attendantChatIds);
  // Rota própria, fora do loop de adapters: o nome "telegram" já é do bot de
  // clientes (/webhook/telegram) e ChannelName não deve ganhar um canal
  // falso — o bot do atendente não é um canal de clientes. O callback de
  // mensagem nunca é usado em modo deskOnly; devolve "" por segurança.
  app.post("/webhook/telegram-desk", (req, res) => {
    telegramDesk.handleWebhook(req, res, async () => "").catch((err) => {
      console.error("Error handling telegram-desk webhook:", err);
      if (!res.headersSent) res.sendStatus(500);
    });
  });
  console.log(`Handoff relay: ${attendantChatIds.size} atendente(s) no Telegram (bot próprio, /webhook/telegram-desk).`);
} else if (telegram && attendantChatIds.size > 0) {
  telegram.desk = new TelegramDesk(deskBotToken!, relay, attendantChatIds);
  console.log(`Handoff relay: ${attendantChatIds.size} atendente(s) no Telegram.`);
}

// Lista de origens externas autorizadas a chamar /webhook/web de um
// browser (ver WIDGET_ALLOWED_ORIGINS em src/config.ts e
// docs/artifacts/widget-embarcavel.html) — o que faz desse canal um widget
// embarcável de verdade no site de um cliente, não só um endpoint de teste
// local. Calculada uma vez, fora do middleware, pra não reprocessar a
// string a cada requisição.
const widgetAllowedOrigins = (env.WIDGET_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Preâmbulo: widgetCors() é um middleware mínimo escrito à mão em vez de
// instalar o pacote `cors` — a regra é simples o bastante (refletir a
// origem SE ela estiver na allowlist, e responder o preflight OPTIONS) que
// uma dependência nova não se paga só por isso. Aplicado SÓ na rota
// /webhook/web (não em /webhook/telegram, /webhook/whatsapp, /api/config ou
// /health) porque é a ÚNICA rota pensada pra ser chamada por JavaScript
// rodando no browser de um domínio diferente — as outras são server-to-
// server (Telegram/Meta) ou ferramentas de uso local (config/health), que
// não precisam e não devem ganhar CORS aberto.
function widgetCors(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const origin = req.headers.origin;
  // Requisição same-origin (ex.: whatsapp.html local) não manda um Origin
  // que precise de liberação — o browser já permite por padrão. Só
  // definimos os headers de CORS quando a origem está explicitamente na
  // allowlist configurada; qualquer outra origem simplesmente não recebe
  // Access-Control-Allow-Origin, e o browser do visitante bloqueia a
  // resposta sozinho, sem o servidor precisar rejeitar nada manualmente.
  if (origin && widgetAllowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    // GET entrou em 05/10/2026 junto com /webhook/web/health e
    // /webhook/web/poll (ver mais abaixo).
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  // Todo browser manda um preflight OPTIONS antes de um POST com
  // Content-Type: application/json cross-origin — responde 204 aqui em vez
  // de deixar cair no handler do WebAdapter, que não sabe lidar com OPTIONS.
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
}

// Para cada adapter habilitado, monta uma rota HTTP em /webhook/<nome> que
// aceita QUALQUER método (app.all) — necessário porque o WhatsApp usa GET
// para verificação e POST para mensagens no mesmo caminho, enquanto
// Telegram e Web só usam POST; deixar o próprio adapter decidir o que fazer
// com cada método (ver WhatsAppAdapter.handleWebhook) evita ter que
// registrar rotas diferentes por canal aqui.
for (const adapter of adapters) {
  // Só o canal "web" é pensado pra ser chamado de um browser em outro
  // domínio (o widget embarcável) — Telegram e WhatsApp chamam o webhook
  // deles mesmos, server-to-server, sem CORS envolvido.
  const middlewares = adapter.name === "web" ? [widgetCors] : [];
  // Extraído como função nomeada (em vez de inline só em um app.all) porque
  // o canal "web" precisa dela montada em DOIS caminhos — ver o alias
  // /webhook/web/message logo abaixo.
  const handleAdapterWebhook = (req: express.Request, res: express.Response) => {
    // Chama o adapter, repassando uma função que só encaminha a mensagem
    // normalizada para o Orchestrator — isso é o que "conecta" o canal ao
    // pipeline central sem o adapter precisar importar o Orchestrator
    // diretamente (inversão de controle: o adapter recebe a função, não a
    // instância inteira).
    adapter.handleWebhook(req, res, (msg) => orchestrator.handleMessage(msg)).catch((err) => {
      // Qualquer erro não tratado dentro do adapter ou do Orchestrator cai
      // aqui — logamos e, SE a resposta HTTP ainda não foi enviada (alguns
      // adapters já respondem 200 antes de processar, como Telegram e
      // WhatsApp), devolvemos 500 para não deixar a requisição pendurada.
      console.error(`Error handling ${adapter.name} webhook:`, err);
      if (!res.headersSent) res.sendStatus(500);
    });
  };
  app.all(`/webhook/${adapter.name}`, ...middlewares, handleAdapterWebhook);
  // Log de inicialização — confirma quais canais ficaram ativos nesta
  // execução do processo, útil ao subir em produção para conferir que a
  // configuração esperada realmente carregou.
  console.log(`Mounted channel adapter: /webhook/${adapter.name}`);

  // Alias só pro canal "web": o widget embarcável do DistributedOrderSystem
  // (chat-widget.min.js) sempre faz POST em "<chatbotServiceUrl>/message" —
  // sufixo fixo no código dele, não configurável. Montar o MESMO handler
  // também em /webhook/web/message permite apontar `chatbotServiceUrl` pra
  // ".../webhook/web" sem editar o JS do widget (ver
  // docs/artifacts/widget-embarcavel.html, Fase 3).
  if (adapter.name === "web") {
    app.all("/webhook/web/message", ...middlewares, handleAdapterWebhook);
    console.log("Mounted widget alias: /webhook/web/message");
  }
}

// GET /webhook/web/health — o widget embarcável chama "<chatbotServiceUrl>/
// health" ao abrir (connectToService() no chat-widget.min.js) pra decidir se
// mostra "Online" ou "Offline" no cabeçalho, e tenta de novo a cada 5s
// enquanto falhar. Essa rota não existia (só /health, na raiz) — por isso o
// widget do site mostrava "Offline" o tempo todo mesmo respondendo
// normalmente, e ficava fazendo uma requisição perdida a cada 5s por
// visitante. Mesmo CORS do resto do canal web.
app.get("/webhook/web/health", widgetCors, (_req, res) => res.json({ ok: true }));

// GET /webhook/web/poll?sessionId=...&after=N — como o widget recebe a
// resposta de um atendente humano (relay de handoff, 05/10/2026). O canal
// web é request/response: o servidor não tem como empurrar mensagem pro
// navegador, então o widget pergunta periodicamente (enquanto a conversa
// está em handoff — ver handoffActive na resposta).
//
// Polling e não SSE/WebSocket: numa VM de 892MB, uma conexão aberta por
// visitante custa memória o tempo todo; um GET curto a cada poucos segundos,
// que só lê o cache em memória do ConversationStore, custa quase nada e
// atravessa o Nginx sem configuração extra.
//
// Segurança: o sessionId funciona como CHAVE de acesso — quem o conhece lê
// as respostas do atendente daquela conversa. Por isso (a) a rota devolve
// SÓ as falas "human-agent", nunca o histórico inteiro, e (b) o widget gera
// o sessionId com crypto.randomUUID() (122 bits aleatórios), não com
// Date.now()+Math.random() como fazia antes.
app.get("/webhook/web/poll", widgetCors, (req, res) => {
  // Aceita os dois nomes, igual ao POST do canal web (ver web.ts): o widget
  // do DistributedOrderSystem usa sessionId; o whatsapp.html usa
  // conversationId.
  const conversationId = String(req.query.sessionId ?? req.query.conversationId ?? "");
  // `after` inválido/negativo vira 0 (= "me manda tudo") — pior caso o
  // widget recebe de novo algo que já mostrou, e ele deduplica pelo id.
  const after = Math.max(0, Number.parseInt(String(req.query.after ?? "0"), 10) || 0);
  // Teto no tamanho do id: nenhum id legítimo passa de ~64 caracteres, e
  // isto evita existsSync com um nome de arquivo gigante vindo da internet.
  if (!conversationId || conversationId.length > 128) {
    res.status(400).json({ error: "sessionId/conversationId is required" });
    return;
  }
  const { messages, cursor } = orchestrator.getHumanRepliesSince(conversationId, after);
  // Só consulta o estado de handoff se a conversa existe — mesmo cuidado
  // de não criar nada por causa de um id inventado.
  const handoffActive = orchestrator.hasConversation(conversationId)
    ? orchestrator.getHandoffState(conversationId).active
    : false;
  res.json({ messages, cursor, handoffActive });
});

// ---------------------------------------------------------------------
// API do Mini App do atendente (public/handoff-app.html) — o caminho
// "mais completo" do relay: histórico inteiro, caixa de resposta e botão de
// devolver ao bot, aberto pelo botão "💬 Abrir conversa" do alerta no
// Telegram. O caminho principal continua sendo o reply direto no Telegram
// (src/handoff/telegramDesk.ts); estas rotas existem pro atendente que quer
// ver a conversa inteira antes de responder.
// ---------------------------------------------------------------------

// Idade máxima aceita do initData (24h): cobre um atendente que deixa o Mini
// App aberto o expediente todo, sem deixar um initData capturado valer pra
// sempre. Ver validateTelegramInitData().
const MINI_APP_INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

// Preâmbulo: requireAttendant() é o middleware de autenticação das rotas
// /api/handoff/*. O Mini App manda o initData que recebeu do Telegram no
// header X-Telegram-Init-Data (header, não querystring, pra não ir parar no
// access log do Nginx); aqui validamos a assinatura com o token do bot e
// conferimos se o user.id está na allowlist de atendentes. 503 se o relay
// não está configurado (sem bot ou sem atendentes), 401 pra initData
// inválido/vencido, 403 pra usuário válido do Telegram que não é atendente.
function requireAttendant(req: express.Request, res: express.Response, next: express.NextFunction): void {
  // deskBotToken (06/10/2026): o Mini App é aberto a partir de uma mensagem
  // do bot do ATENDENTE, e o Telegram assina o initData com o token desse
  // bot — validar com o token do bot de clientes recusaria todo mundo.
  if (!deskBotToken || attendantChatIds.size === 0) {
    res.status(503).json({ error: "Relay de handoff não configurado neste servidor." });
    return;
  }
  const initData = req.header("X-Telegram-Init-Data") ?? "";
  const userId = validateTelegramInitData(initData, deskBotToken, MINI_APP_INIT_DATA_MAX_AGE_SECONDS);
  if (!userId) {
    res.status(401).json({ error: "Abra esta página pelo botão do alerta no Telegram." });
    return;
  }
  if (!attendantChatIds.has(userId)) {
    res.status(403).json({ error: "Seu usuário do Telegram não está cadastrado como atendente." });
    return;
  }
  next();
}

// GET /api/handoff/:conversationId — histórico completo + estado, pro Mini
// App montar a tela. 404 pra conversa inexistente (não cria nada).
app.get("/api/handoff/:conversationId", requireAttendant, (req, res) => {
  const { conversationId } = req.params;
  if (!orchestrator.hasConversation(conversationId)) {
    res.status(404).json({ error: "Conversa não encontrada." });
    return;
  }
  const state = orchestrator.getHandoffState(conversationId);
  res.json({
    conversationId,
    channel: state.channel ?? null,
    active: state.active,
    since: state.since,
    history: orchestrator.getHistory(conversationId),
  });
});

// POST /api/handoff/:conversationId/reply {text} — mesma operação do reply
// no Telegram, pelo mesmo HumanRelay (validação de tamanho, ordem
// "envia -> grava", reativação do handoff).
app.post("/api/handoff/:conversationId/reply", requireAttendant, async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  // try/catch porque o Express 4 não captura rejeição de handler async —
  // um erro inesperado (ex.: falha de escrita em disco no append) viraria
  // uma unhandled rejection e a requisição do Mini App ficaria pendurada.
  try {
    const result = await relay.reply(req.params.conversationId, text);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    console.error("Handoff relay reply failed:", err);
    res.status(500).json({ ok: false, error: "Erro interno ao enviar — veja o log do servidor." });
  }
});

// POST /api/handoff/:conversationId/release — botão "Devolver ao bot".
app.post("/api/handoff/:conversationId/release", requireAttendant, (req, res) => {
  const result = relay.release(req.params.conversationId);
  res.status(result.ok ? 200 : 400).json(result);
});

// POST /api/handoff/:conversationId/close — botão "Encerrar atendimento" do
// Mini App (05/10/2026): avisa o cliente e devolve ao bot (ver
// HumanRelay.close). try/catch pelo mesmo motivo da rota /reply.
app.post("/api/handoff/:conversationId/close", requireAttendant, async (req, res) => {
  try {
    const result = await relay.close(req.params.conversationId, "attendant");
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    console.error("Handoff relay close failed:", err);
    res.status(500).json({ ok: false, error: "Erro interno ao encerrar — veja o log do servidor." });
  }
});

// Varredura de inatividade (05/10/2026): a cada minuto, encerra os
// atendimentos humanos sem nenhuma mensagem há handoffInactivityMinutes (lido
// a cada rodada, então mudar pela tela de configuração vale sem reiniciar).
// Custo: ler alguns arquivos de poucos bytes por minuto — desprezível na B1s.
// `.unref()` pra este timer não impedir o processo de terminar num shutdown.
// O `running` evita duas rodadas sobrepostas se uma entrega (API do
// Telegram/WhatsApp lenta) passar de um minuto.
const INACTIVITY_SWEEP_MS = 60_000;
let inactivitySweepRunning = false;
setInterval(() => {
  if (inactivitySweepRunning) return;
  inactivitySweepRunning = true;
  relay
    .closeInactive(agentConfig.handoffInactivityMinutes)
    .then((closed) => {
      if (closed.length) console.log(`Handoff: ${closed.length} atendimento(s) encerrado(s) por inatividade.`);
    })
    .catch((err) => console.error("Inactivity sweep failed:", err))
    .finally(() => {
      inactivitySweepRunning = false;
    });
}, INACTIVITY_SWEEP_MS).unref();

// GET /api/config — devolve a configuração de negócio atual (agentConfig),
// consumida pela tela de configuração (public/settings.html) pra preencher
// o formulário. Nada em agentConfig é segredo (ver separação env/agentConfig
// em src/config.ts — API keys e tokens vivem só no .env e nunca passam por
// aqui), então devolver o objeto inteiro é seguro.
app.get("/api/config", (_req, res) => {
  res.json(agentConfig);
});

// POST /api/config — salva uma nova configuração vinda da tela. Reaproveita
// o MESMO AgentConfigSchema (zod) e a MESMA validateCrossConfig() que
// protegem a leitura do arquivo na inicialização do processo (ver
// src/config.ts) — nunca confia no payload vindo do browser sem passar pela
// mesma validação que já protege o arquivo em disco.
app.post("/api/config", (req, res) => {
  let candidate;
  try {
    candidate = AgentConfigSchema.parse(req.body);
    validateCrossConfig(candidate);
  } catch (err) {
    // ZodError.message é o array de issues inteiro serializado em JSON —
    // correto, mas ilegível numa tela de erro. Reformata como uma linha por
    // campo ("campo: problema"), que é o que public/settings.html de fato
    // mostra pro usuário. validateCrossConfig() lança um Error comum (não
    // ZodError) com mensagem já pronta em uma linha — repassa direto.
    const message =
      err instanceof ZodError
        ? err.issues.map((issue) => `${issue.path.join(".") || "(config)"}: ${issue.message}`).join("; ")
        : (err as Error).message;
    res.status(400).json({ error: message });
    return;
  }

  try {
    // Backup do conteúdo anterior antes de sobrescrever — rede de segurança
    // barata, já que esta rota pode ser chamada por qualquer um com acesso
    // à rede local (sem autenticação, mesma postura do resto da ferramenta
    // de debug local).
    if (existsSync(agentConfigPath)) {
      copyFileSync(agentConfigPath, `${agentConfigPath}.bak`);
    }
    writeFileSync(agentConfigPath, JSON.stringify(candidate, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error("Failed to write agent.config.json:", err);
    res.status(500).json({ error: "Falha ao gravar o arquivo de configuração no disco." });
    return;
  }

  // Object.assign (em vez de reatribuir `agentConfig`, que é `const` e
  // importado por referência em todo módulo do projeto) muta o MESMO objeto
  // que promptBuilder/handoff/capabilityRouter/knowledgeBase já leem sob
  // demanda a cada mensagem — é o que faz a mudança valer imediatamente,
  // sem reiniciar `npm run dev`.
  Object.assign(agentConfig, candidate);
  // Propaga pras três peças que capturam valores em construtores (limites
  // do rate limiter, timeout de handoff, tipo de handoff notifier) — ver
  // Orchestrator.reloadConfig().
  orchestrator.reloadConfig();

  res.json({ ok: true, config: agentConfig });
});

// Endpoint simples de health check — usado por ferramentas de
// monitoramento/orquestração de containers para saber se o processo está
// vivo e respondendo, sem depender de nenhuma credencial externa.
app.get("/health", (_req, res) => res.json({ ok: true }));

// GET /debug/rag-search?q=... — devolve os trechos recuperados PELO
// RETRIEVAL CRU (score do reranker, item completo), sem passar pelo LLM de
// geração. Existe só pra alimentar o harness RAGAS em Python (eval/, ver
// README desse harness) e pra depuração manual — RAGAS precisa do contexto
// recuperado separado da resposta final pra calcular Faithfulness/Context
// Precision, e o contrato público /webhook/web/message nunca expõe isso
// (só devolve {reply, message}, ver webContract.test.ts).
//
// Gate por NODE_ENV, não por feature flag: diferente de
// ORDER_HISTORY_RAG_ENABLED no AgentService irmão (que liga/desliga uma
// CAPACIDADE do produto), esta rota não tem nenhuma utilidade em produção
// pro cliente final — só serve pra quem está rodando eval/CI localmente —
// então nem é montada no processo quando NODE_ENV=production, em vez de
// montada-mas-recusando-responder. Uma rota que não existe não pode ser
// descoberta por scan de superfície de ataque.
if (process.env.NODE_ENV !== "production") {
  // Instância própria, independente da que o Orchestrator usa internamente
  // (orchestrator.ts linha ~54) — KnowledgeBase não guarda estado por
  // sessão/conversa (só o provider de embedding, carregado uma vez), então
  // ter uma segunda instância aqui não duplica nenhum dado, só mantém esta
  // rota de debug desacoplada do Orchestrator.
  const debugKnowledgeBase = new KnowledgeBase();
  app.get("/debug/rag-search", async (req, res) => {
    const query = String(req.query.q ?? "");
    if (!query) {
      res.status(400).json({ error: "q (query string) is required" });
      return;
    }
    try {
      const results = await debugKnowledgeBase.search(query);
      res.json({
        query,
        results: results.map((r) => ({ title: r.item.title, content: r.item.content, score: r.score })),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  console.log("Mounted debug route: /debug/rag-search (NODE_ENV != production)");
}

// Sobe o servidor HTTP na porta configurada (env.PORT, default 3000) e
// confirma no console quando está pronto para receber requisições.
app.listen(env.PORT, () => {
  console.log(`Agent server listening on port ${env.PORT}`);
});
