// "Balcão do atendente" no Telegram — o caminho PRINCIPAL do relay de
// handoff (05/10/2026): o atendente recebe o alerta do TelegramNotifier no
// chat dele com o bot, dá "Responder" (reply) em qualquer mensagem do bot
// que termine com "🆔 <id>", e o texto vai pro cliente na conversa
// original. Nada de link, página ou senha — a autenticação é o próprio
// Telegram: o update só chega aqui se (a) veio do Telegram (header secreto
// do webhook, obrigatório quando há atendentes — ver src/config.ts) e (b) o
// chat id de origem está na allowlist HANDOFF_TELEGRAM_CHAT_IDS.
//
// O TelegramAdapter (src/channels/telegram.ts) desvia pra cá todo update de
// atendente ANTES de chegar no Orchestrator — um atendente nunca é tratado
// como cliente do bot.
import { callTelegram } from "../channels/telegramApi.js";
import { extractConversationId, formatConversationMarker } from "./attendants.js";
import type { HumanRelay } from "./relay.js";

// Formato (parcial) da mensagem de atendente que este módulo entende — os
// campos extras de um update do Telegram que o TelegramAdapter repassa.
export interface DeskMessage {
  chat: { id: number };
  text?: string;
  // Mensagem à qual o atendente respondeu (quando usa "Responder"). `from`
  // vem junto pra conferir que a mensagem original é do BOT — o marcador
  // só tem valor se foi o bot que o escreveu.
  reply_to_message?: { text?: string; from?: { is_bot?: boolean } };
}

// Formato (parcial) de um clique em botão inline (callback_data).
export interface DeskCallbackQuery {
  id: string;
  from: { id: number };
  data?: string;
  // Mensagem onde estava o botão — usada pra responder no mesmo chat.
  message?: { chat: { id: number } };
}

// Texto de ajuda mostrado quando o atendente manda algo que não é reply a
// uma mensagem do bot — o erro mais provável é esquecer de usar "Responder".
const HELP_TEXT = [
  "Você está cadastrado como atendente.",
  "",
  "• Pra falar com um cliente: toque e segure (ou deslize) uma mensagem minha que termine com 🆔 e escolha \"Responder\".",
  "• /encerrar (como resposta a uma mensagem com 🆔): encerra o atendimento, avisa o cliente e devolve ao bot.",
  "• /liberar (como resposta a uma mensagem com 🆔): devolve a conversa ao bot sem avisar o cliente.",
  "• O botão \"💬 Abrir conversa\" no alerta mostra o histórico completo.",
].join("\n");

// Preâmbulo: closeConfirmation() — texto de confirmação de encerramento pro
// atendente; avisa quando a mensagem de encerramento não chegou ao cliente
// (o atendimento foi encerrado mesmo assim — ver HumanRelay.close()).
function closeConfirmation(delivered: boolean | undefined): string {
  return delivered === false
    ? "✅ Atendimento encerrado — mas o aviso NÃO chegou ao cliente (veja o log do servidor)."
    : "✅ Atendimento encerrado — o cliente foi avisado e o bot volta a responder.";
}

// Preâmbulo: TelegramDesk é instanciado uma vez em src/server.ts quando há
// token do Telegram e atendentes configurados, e entregue ao
// TelegramAdapter. Recebe o HumanRelay pronto — este módulo só traduz
// "gesto no Telegram" em "chamada ao relay" e devolve feedback ao
// atendente.
export class TelegramDesk {
  constructor(
    private readonly botToken: string,
    private readonly relay: HumanRelay,
    private readonly attendantChatIds: Set<string>
  ) {}

  // Preâmbulo: isAttendant() — usado pelo TelegramAdapter pra decidir se
  // um update vai pro Orchestrator (cliente) ou pra cá (atendente).
  isAttendant(chatOrUserId: string): boolean {
    return this.attendantChatIds.has(chatOrUserId);
  }

  // Preâmbulo: say() manda uma resposta curta pro atendente. Termina com o
  // marcador quando há uma conversa em jogo — assim o atendente pode dar
  // reply também na confirmação ("✅ Enviado"), sem precisar rolar até o
  // alerta original pra mandar a próxima mensagem.
  private async say(chatId: string, text: string, conversationId?: string): Promise<void> {
    const body = conversationId ? `${text}\n${formatConversationMarker(conversationId)}` : text;
    await callTelegram(this.botToken, "sendMessage", { chat_id: chatId, text: body });
  }

  // Preâmbulo: handleMessage() trata uma mensagem de texto de um atendente
  // (o TelegramAdapter já conferiu isAttendant()). Três casos:
  //  1. reply a uma mensagem do bot com marcador + "/liberar" -> devolve ao bot;
  //  2. reply a uma mensagem do bot com marcador + texto -> relay pro cliente;
  //  3. qualquer outra coisa -> ajuda.
  async handleMessage(message: DeskMessage): Promise<void> {
    const chatId = String(message.chat.id);
    const text = message.text?.trim() ?? "";
    const original = message.reply_to_message;
    // Só aceita marcador vindo de mensagem do BOT: se o atendente der reply
    // numa mensagem DELE MESMO que contenha "🆔 x" (ex.: colou um alerta),
    // não queremos adivinhar — pede pra responder ao alerta de verdade.
    const conversationId = original?.from?.is_bot ? extractConversationId(original.text) : null;

    if (!conversationId) {
      await this.say(chatId, HELP_TEXT);
      return;
    }

    // /encerrar: encerra com aviso ao cliente (ver HumanRelay.close). Sem
    // marcador na confirmação — a conversa acabou, e um reply nela
    // reabriria o atendimento sem querer.
    if (text === "/encerrar") {
      const result = await this.relay.close(conversationId, "attendant");
      await this.say(chatId, result.ok ? closeConfirmation(result.delivered) : `⚠️ ${result.error}`);
      return;
    }

    if (text === "/liberar") {
      const result = this.relay.release(conversationId);
      await this.say(chatId, result.ok ? "🤖 Conversa devolvida ao bot." : `⚠️ ${result.error}`, conversationId);
      return;
    }

    const result = await this.relay.reply(conversationId, text);
    if (!result.ok) {
      await this.say(chatId, `⚠️ Não enviado: ${result.error}`, conversationId);
      return;
    }
    // Confirmação curta. Se a conversa tinha sido devolvida ao bot (ou
    // expirado) e esta resposta a reativou, avisa — o atendente precisa
    // saber que o bot parou de responder de novo por causa dele.
    const note = result.reactivated ? " (a conversa voltou pra você — o bot está em silêncio de novo)" : "";
    await this.say(chatId, `✅ Enviado${note}.`, conversationId);
  }

  // Preâmbulo: handleCallback() trata o clique no botão "🤖 Devolver ao
  // bot" (callback_data "rel:<id>"). Confere a allowlist pelo `from.id` de
  // quem CLICOU (não pelo chat): é a pessoa que importa. Sempre chama
  // answerCallbackQuery — sem isso o Telegram deixa o botão "carregando"
  // no app do atendente por vários segundos.
  async handleCallback(query: DeskCallbackQuery): Promise<void> {
    const allowed = this.isAttendant(String(query.from.id));
    const data = query.data ?? "";

    if (!allowed || !(data.startsWith("rel:") || data.startsWith("end:"))) {
      await callTelegram(this.botToken, "answerCallbackQuery", { callback_query_id: query.id, text: "Ação não permitida." });
      return;
    }

    // "end:<id>" = ✅ Encerrar atendimento (05/10/2026): avisa o cliente e
    // devolve ao bot. Confirmação sem marcador (ver /encerrar acima).
    if (data.startsWith("end:")) {
      const result = await this.relay.close(data.slice("end:".length), "attendant");
      await callTelegram(this.botToken, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: result.ok ? "Atendimento encerrado." : result.error,
      });
      if (result.ok && query.message) {
        await this.say(String(query.message.chat.id), closeConfirmation(result.delivered));
      }
      return;
    }

    const conversationId = data.slice("rel:".length);
    const result = this.relay.release(conversationId);
    await callTelegram(this.botToken, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: result.ok ? "Conversa devolvida ao bot." : result.error,
    });
    // Registro visível no chat (o toast do answerCallbackQuery some em 2s)
    // — útil quando há mais de um atendente olhando o mesmo alerta.
    if (result.ok && query.message) {
      await this.say(String(query.message.chat.id), "🤖 Conversa devolvida ao bot.", conversationId);
    }
  }
}
