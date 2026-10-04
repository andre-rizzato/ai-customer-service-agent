// Ponto de entrada do processo servidor: sobe um app Express, monta um
// Orchestrator, monta um ChannelAdapter por canal habilitado, e conecta
// cada adapter à sua própria rota de webhook. Este arquivo é
// deliberadamente "burro" — toda a lógica de negócio vive no Orchestrator e
// nos adapters; aqui só existe fiação (wiring).
import express from "express";
import { env } from "./config.js";
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

// Para cada adapter habilitado, monta uma rota HTTP em /webhook/<nome> que
// aceita QUALQUER método (app.all) — necessário porque o WhatsApp usa GET
// para verificação e POST para mensagens no mesmo caminho, enquanto
// Telegram e Web só usam POST; deixar o próprio adapter decidir o que fazer
// com cada método (ver WhatsAppAdapter.handleWebhook) evita ter que
// registrar rotas diferentes por canal aqui.
for (const adapter of adapters) {
  app.all(`/webhook/${adapter.name}`, (req, res) => {
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

// Endpoint simples de health check — usado por ferramentas de
// monitoramento/orquestração de containers para saber se o processo está
// vivo e respondendo, sem depender de nenhuma credencial externa.
app.get("/health", (_req, res) => res.json({ ok: true }));

// Sobe o servidor HTTP na porta configurada (env.PORT, default 3000) e
// confirma no console quando está pronto para receber requisições.
app.listen(env.PORT, () => {
  console.log(`Agent server listening on port ${env.PORT}`);
});
