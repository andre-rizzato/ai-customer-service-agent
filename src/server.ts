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
import { createTelegramAdapter } from "./channels/telegram.js";
import { createWhatsAppAdapter } from "./channels/whatsapp.js";
import { WebAdapter } from "./channels/web.js";
import type { ChannelAdapter } from "./channels/types.js";

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
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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
  app.all(`/webhook/${adapter.name}`, ...middlewares, (req, res) => {
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
  });
  // Log de inicialização — confirma quais canais ficaram ativos nesta
  // execução do processo, útil ao subir em produção para conferir que a
  // configuração esperada realmente carregou.
  console.log(`Mounted channel adapter: /webhook/${adapter.name}`);
}

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

// Sobe o servidor HTTP na porta configurada (env.PORT, default 3000) e
// confirma no console quando está pronto para receber requisições.
app.listen(env.PORT, () => {
  console.log(`Agent server listening on port ${env.PORT}`);
});
