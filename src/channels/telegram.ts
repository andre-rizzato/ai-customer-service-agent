// Adapter de canal para o Telegram Bot API. Traduz o formato de "update" do
// Telegram para InboundMessage, chama o Orchestrator, e envia a resposta de
// volta usando o método sendMessage da API do Telegram.
//
// Revisão de segurança de 04/10/2026 (docs/SECURITY_REVIEW.md) acrescentou
// deduplicação por update_id (item #1 — o Telegram também pode reentregar
// um webhook, mesmo raciocínio do WhatsApp).
import type { Request, Response } from "express";
import { env } from "../config.js";
import type { InboundMessage } from "../types.js";
import type { ChannelAdapter } from "./types.js";
import { DedupeCache } from "../orchestrator/dedupeCache.js";
import { callTelegram } from "./telegramApi.js";
import type { DeskCallbackQuery, DeskMessage, TelegramDesk } from "../handoff/telegramDesk.js";

// Mesmo valor e mesmo raciocínio do WhatsAppAdapter (ver
// src/channels/whatsapp.ts) — 10 minutos cobre qualquer janela real de
// reenvio sem guardar id em memória além do necessário.
const DEDUPE_TTL_MS = 10 * 60 * 1000;

// Formato (parcial — só os campos que este adapter usa) de um "update" que
// o Telegram envia via webhook. O Telegram manda updates de vários tipos
// (mensagem editada, membro do grupo mudou, etc.); só nos interessa
// `message`, e dentro dele só mensagens de texto.
interface TelegramUpdate {
  // Identificador único e crescente de cada update, atribuído pelo
  // próprio Telegram — estável entre reentregas do MESMO evento. Usado
  // pelo DedupeCache (ver handleWebhook abaixo) pra detectar reenvio.
  update_id: number;
  // `DeskMessage` traz chat/text/reply_to_message (este último só usado
  // quando quem escreve é um atendente — ver src/handoff/telegramDesk.ts).
  message?: DeskMessage & {
    // Timestamp em SEGUNDOS desde epoch (padrão Unix) — diferente de
    // Date.now() do JS, que é em milissegundos; por isso é multiplicado por
    // 1000 mais abaixo ao montar o InboundMessage.
    date: number;
  };
  // Clique num botão inline (ex.: "🤖 Devolver ao bot" no alerta de
  // handoff). Só chega aqui se o setWebhook não tiver restringido
  // allowed_updates a ["message"] — o default do Telegram inclui
  // callback_query.
  callback_query?: DeskCallbackQuery;
}

// Preâmbulo: TelegramAdapter implementa ChannelAdapter para o canal
// Telegram. Só é instanciado (via createTelegramAdapter, no final do
// arquivo) se TELEGRAM_BOT_TOKEN estiver configurado no .env — caso
// contrário o canal fica desabilitado e src/server.ts nem monta a rota
// correspondente.
//
// Setup fora deste código: registre o webhook uma vez, apontando para a URL
// pública deste servidor, chamando:
//   https://api.telegram.org/bot<TOKEN>/setWebhook?url=<sua-url>/webhook/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>
export class TelegramAdapter implements ChannelAdapter {
  // Satisfaz ChannelAdapter.name — usado por server.ts para montar a rota
  // /webhook/telegram.
  readonly name = "telegram" as const;

  // Instância própria de DedupeCache — ver comentário equivalente em
  // WhatsAppAdapter sobre por que cada canal guarda a sua, sem compartilhar.
  private readonly dedupe = new DedupeCache(DEDUPE_TTL_MS);

  // Balcão do atendente (relay de handoff, 05/10/2026). Atribuído por
  // src/server.ts DEPOIS da construção — e não recebido no construtor —
  // porque o desk depende do HumanRelay, que depende do sendMessage DESTE
  // adapter: passar no construtor criaria uma dependência circular de
  // inicialização. undefined = sem atendentes configurados, todo update é
  // tratado como cliente (comportamento anterior).
  desk?: TelegramDesk;

  constructor(private readonly botToken: string, private readonly webhookSecret?: string) {}

  // Preâmbulo: handleWebhook() é chamado por src/server.ts para toda
  // requisição HTTP recebida em /webhook/telegram. Faz quatro coisas em
  // sequência: valida o segredo do webhook (se configurado), confirma
  // recebimento, deduplica por update_id, e — se houver texto novo — chama
  // o Orchestrator e envia a resposta de volta via API do Telegram.
  async handleWebhook(
    req: Request,
    res: Response,
    onMessage: (msg: InboundMessage) => Promise<string>
  ): Promise<void> {
    // Se um segredo foi configurado (TELEGRAM_WEBHOOK_SECRET), o Telegram é
    // instruído (no momento do setWebhook) a incluir esse mesmo valor no
    // header abaixo em toda chamada — isso evita que qualquer pessoa na
    // internet descubra a URL do webhook e finja ser o Telegram enviando
    // mensagens falsas para o agente.
    if (this.webhookSecret) {
      const provided = req.header("X-Telegram-Bot-Api-Secret-Token");
      if (provided !== this.webhookSecret) {
        // 401 Unauthorized: rejeita sem processar nada do corpo da
        // requisição.
        res.sendStatus(401);
        return;
      }
    }

    // Faz o cast do corpo da requisição (já parseado como JSON pelo
    // middleware express.json() em server.ts) para o formato esperado.
    const update = req.body as TelegramUpdate;

    // Responde 200 ao Telegram IMEDIATAMENTE, antes de processar a
    // mensagem — o Telegram reenvia o webhook se não receber um 200
    // rapidamente, e como a resposta do LLM pode demorar alguns segundos,
    // confirmamos o recebimento primeiro para evitar reenvios duplicados
    // do mesmo update. A deduplicação abaixo cobre o caso de o Telegram
    // reenviar mesmo assim, por outro motivo de rede do lado dele.
    res.sendStatus(200);

    // Deduplicação: se já vimos este update_id dentro da janela de TTL,
    // isto é uma reentrega — pula sem chamar o Orchestrator de novo.
    if (this.dedupe.hasSeenAndRecord(String(update.update_id))) {
      console.warn(`Telegram: update ${update.update_id} já processado, ignorando reentrega.`);
      return;
    }

    // Clique em botão inline: só existe nos alertas de handoff, então vai
    // direto pro desk (que confere se quem clicou é atendente). Sem desk
    // configurado, ignora — nenhum botão nosso deveria existir.
    if (update.callback_query) {
      if (this.desk) await this.desk.handleCallback(update.callback_query);
      return;
    }

    const message = update.message;
    // Ignora updates sem texto (figurinha, foto, membro entrou no grupo,
    // etc.) — este agente só sabe lidar com texto.
    if (!message?.text) return;

    // O chat id do Telegram é number; convertido para string porque
    // InboundMessage.conversationId/userId são sempre string em todo o
    // pipeline (mantém o formato uniforme entre canais, já que o WhatsApp
    // usa string nativamente — o número de telefone).
    const chatId = String(message.chat.id);

    // /meuid: responde o chat id de quem perguntou — é como um atendente
    // descobre o valor pra pôr em HANDOFF_TELEGRAM_CHAT_IDS. Respondido pra
    // QUALQUER pessoa (não só atendentes, que ainda nem estariam na lista):
    // o chat id não é segredo nem dá acesso a nada sozinho. Interceptado
    // antes do Orchestrator pra não gastar uma chamada de LLM com isso.
    if (message.text.trim() === "/meuid") {
      await this.sendMessage(chatId, `Seu chat id: ${chatId}`);
      return;
    }

    // Mensagem de um atendente: vai pro balcão (relay), NUNCA pro
    // Orchestrator — senão o bot responderia ao atendente como se ele fosse
    // cliente, e um reply com "falar com atendente" abriria um handoff do
    // próprio atendente. Efeito colateral conhecido: quem está na lista não
    // consegue testar o bot como cliente por este mesmo chat.
    if (this.desk?.isAttendant(chatId)) {
      await this.desk.handleMessage(message);
      return;
    }
    const inbound: InboundMessage = {
      channel: this.name,
      userId: chatId,
      // No Telegram, conversationId e userId são o mesmo valor porque cada
      // chat 1:1 com o bot já é uma conversa isolada por definição da
      // própria API do Telegram.
      conversationId: chatId,
      text: message.text,
      // Converte segundos (Telegram) para milissegundos (padrão interno do
      // projeto, igual ao que Date.now() produz).
      timestamp: message.date * 1000,
    };

    // Delega ao Orchestrator todo o processamento (RAG, prompt, LLM,
    // handoff, log) — este adapter não sabe nem precisa saber o que
    // acontece dentro de onMessage.
    const reply = await onMessage(inbound);
    // Reply vazio é o sinal do Orchestrator pra "não responda nada" —
    // acontece quando a conversa está em handoff ativo (bot silenciado,
    // ver src/orchestrator/handoffState.ts, item #5 da revisão de
    // segurança) e também no caso de rate limit. Sem este if, mandaríamos
    // uma mensagem vazia pro chat real.
    if (reply) await this.sendMessage(chatId, reply);
  }

  // Preâmbulo: sendMessage() encapsula a chamada ao método sendMessage da
  // API do Telegram. Método público (não só usado internamente por
  // handleWebhook) porque o relay de handoff (src/handoff/relay.ts) o usa
  // pra entregar a resposta do atendente a um cliente do Telegram — mensagem
  // proativa, fora do fluxo de resposta a um webhook.
  //
  // Devolve se o Telegram aceitou (antes era void): o relay precisa saber,
  // pra não dizer "✅ Enviado" ao atendente quando a mensagem não chegou.
  // Continua sem lançar — uma falha ao ENVIAR não deveria derrubar o
  // processo nem impedir o próximo webhook de ser processado (ver
  // callTelegram em telegramApi.ts, que centraliza esse tratamento).
  async sendMessage(chatId: string, text: string): Promise<boolean> {
    return callTelegram(this.botToken, "sendMessage", { chat_id: chatId, text });
  }
}

// Preâmbulo: createTelegramAdapter() é a factory usada por src/server.ts
// para decidir se o canal Telegram deve ser habilitado — devolve `null`
// (em vez de lançar erro) se TELEGRAM_BOT_TOKEN não estiver configurado,
// permitindo rodar o servidor só com WhatsApp, só com Telegram, ou com os
// dois ao mesmo tempo, dependendo do que estiver no .env.
export function createTelegramAdapter(): TelegramAdapter | null {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  return new TelegramAdapter(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET);
}
