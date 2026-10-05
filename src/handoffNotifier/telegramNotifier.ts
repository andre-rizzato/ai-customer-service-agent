// Implementação de HandoffNotifier que avisa o(s) atendente(s) por mensagem
// no Telegram, usando o MESMO bot do canal Telegram (TELEGRAM_BOT_TOKEN) —
// e, diferente do WebhookNotifier, sustenta uma conversa de ida e volta: o
// alerta e cada mensagem nova do cliente terminam com a linha "🆔 <id>"
// (ver src/handoff/attendants.ts), então o atendente só precisa dar
// "Responder" (reply) numa delas pra falar com o cliente — o
// TelegramDesk (src/handoff/telegramDesk.ts) recebe esse reply e o relay
// entrega. Construído em 05/10/2026 (Opção B do item #5 de
// docs/SECURITY_REVIEW.md). Usado quando agentConfig.handoffNotifier ===
// "telegram".
//
// Por que Telegram pro atendente (e não WhatsApp/Discord): o bot já está
// integrado (zero processo novo na VM), mensagem do bot pro atendente é
// gratuita (no WhatsApp seria template pago fora da janela de 24h), e o
// Telegram tem Mini App com autenticação assinada (initData).
import type { ChannelName, ConversationTurn } from "../types.js";
import type { HandoffReason } from "../orchestrator/handoff.js";
import type { HandoffNotifier } from "./types.js";
import { callTelegram } from "../channels/telegramApi.js";
import { formatConversationMarker, sanitizeQuoted } from "../handoff/attendants.js";

// Quantos turnos do histórico entram no alerta, e o tamanho máximo de cada
// um. O Telegram corta mensagens acima de 4096 caracteres (recusa o envio,
// na verdade) — 10 turnos x 300 caracteres + cabeçalho fica bem abaixo
// disso. O histórico COMPLETO continua disponível no Mini App.
const ALERT_MAX_TURNS = 10;
const ALERT_MAX_TURN_CHARS = 300;

// Rótulo legível por papel — o atendente não precisa saber o nome interno
// "human-agent"/"system-note".
const ROLE_LABEL: Record<ConversationTurn["role"], string> = {
  user: "👤 Cliente",
  assistant: "🤖 Bot",
  "human-agent": "🧑‍💼 Atendente",
  "system-note": "📝 Nota",
};

// Motivo do handoff em português, pro cabeçalho do alerta.
function describeReason(reason: HandoffReason): string {
  switch (reason) {
    case "explicit_request":
      return "pedido de atendimento humano (ou assunto que exige um)";
    case "frustration":
      return "sinais de frustração do cliente";
    default:
      return "não informado";
  }
}

// Nome do canal do CLIENTE em português — "web" sozinho não diz muito pra
// quem está lendo no celular.
const CHANNEL_LABEL: Record<ChannelName, string> = {
  web: "widget do site",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
};

// Preâmbulo: truncate() corta um texto longo com reticências — usado em
// cada turno citado no alerta.
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Preâmbulo: TelegramNotifier implementa HandoffNotifier mandando mensagens
// para cada chat id da allowlist de atendentes. Instanciada por
// src/handoffNotifier/index.ts. `publicBaseUrl` é opcional: sem ele (ex.:
// rodando local sem HTTPS), o alerta sai sem o botão do Mini App — o reply
// direto continua funcionando, que é o caminho principal.
export class TelegramNotifier implements HandoffNotifier {
  constructor(
    private readonly botToken: string,
    private readonly attendantChatIds: Set<string>,
    private readonly publicBaseUrl?: string
  ) {}

  // Preâmbulo: buildKeyboard() monta os botões inline do alerta, por chat
  // de destino:
  //  - "💬 Abrir conversa" (web_app): abre public/handoff-app.html DENTRO
  //    do Telegram como Mini App. O Telegram só aceita botão web_app em
  //    chat PRIVADO com o bot e com URL https — chat id negativo é grupo,
  //    então o botão é omitido ali (senão o sendMessage inteiro falharia
  //    com BUTTON_TYPE_INVALID e o atendente não receberia nem o alerta).
  //  - "🤖 Devolver ao bot" (callback_data "rel:<id>"): tratado pelo
  //    TelegramDesk. callback_data tem limite de 64 BYTES — um id maior que
  //    isso (não acontece com uuid, chat id ou telefone) simplesmente não
  //    ganha o botão; o atendente ainda pode usar /liberar.
  private buildKeyboard(chatId: string, conversationId: string): Record<string, unknown> | undefined {
    const rows: Record<string, unknown>[][] = [];
    const isPrivateChat = !chatId.startsWith("-");
    if (this.publicBaseUrl?.startsWith("https://") && isPrivateChat) {
      // conversationId vai na querystring (não no fragmento #) porque o
      // Telegram usa o fragmento da URL do Mini App pra injetar os próprios
      // parâmetros (tgWebAppData etc.). O id NÃO é segredo pro atendente — ele
      // já aparece no texto do alerta, dentro do mesmo Telegram.
      const url = `${this.publicBaseUrl.replace(/\/$/, "")}/handoff-app.html?c=${encodeURIComponent(conversationId)}`;
      rows.push([{ text: "💬 Abrir conversa", web_app: { url } }]);
    }
    const callbackData = `rel:${conversationId}`;
    if (Buffer.byteLength(callbackData, "utf-8") <= 64) {
      rows.push([{ text: "🤖 Devolver ao bot", callback_data: callbackData }]);
    }
    return rows.length ? { inline_keyboard: rows } : undefined;
  }

  // Preâmbulo: sendToAttendants() envia o mesmo texto pra todos os
  // atendentes em paralelo (Promise.all) — com 2-3 atendentes, esperar um
  // de cada vez somaria latência à toa. callTelegram nunca lança, então um
  // atendente com chat id errado não impede os outros de receberem.
  private async sendToAttendants(text: string, conversationId: string, withKeyboard: boolean): Promise<void> {
    await Promise.all(
      [...this.attendantChatIds].map((chatId) =>
        callTelegram(this.botToken, "sendMessage", {
          chat_id: chatId,
          text,
          // Sem parse_mode (texto puro) de propósito: o texto inclui falas
          // do cliente, e com Markdown/HTML qualquer "*" ou "<" digitado por
          // ele quebraria a formatação ou faria o Telegram recusar a mensagem.
          reply_markup: withKeyboard ? this.buildKeyboard(chatId, conversationId) : undefined,
          // Sem prévia de link: se o cliente colou uma URL, o Telegram
          // buscaria a página pra montar a prévia — desnecessário e, no
          // caso de links com token, potencialmente um "clique" indesejado.
          link_preview_options: { is_disabled: true },
        })
      )
    );
  }

  // Preâmbulo: notify() é chamado pelo Orchestrator quando um handoff
  // dispara. Monta o alerta com cabeçalho, as últimas mensagens e a linha
  // de instrução, e termina SEMPRE com o marcador "🆔 <id>" — é ele que
  // permite o reply (ver extractConversationId).
  async notify(conversationId: string, reason: HandoffReason, history: ConversationTurn[], channel: ChannelName): Promise<void> {
    const recent = history
      .filter((turn) => turn.role !== "system-note")
      .slice(-ALERT_MAX_TURNS)
      .map((turn) => `${ROLE_LABEL[turn.role]}: ${truncate(sanitizeQuoted(turn.text), ALERT_MAX_TURN_CHARS)}`);

    const text = [
      `🔔 Handoff — cliente no ${CHANNEL_LABEL[channel]}`,
      `Motivo: ${describeReason(reason)}`,
      "",
      "Últimas mensagens:",
      ...recent,
      "",
      "↩️ Responda (reply) a esta mensagem pra falar com o cliente.",
      formatConversationMarker(conversationId),
    ].join("\n");

    await this.sendToAttendants(text, conversationId, true);
  }

  // Preâmbulo: onCustomerMessage() repassa cada mensagem nova do cliente
  // durante o handoff — também com o marcador, então o atendente pode dar
  // reply direto nela (é o jeito natural de conversar no Telegram, sem ter
  // que rolar até o alerta original). Sem teclado: os botões já estão no
  // alerta, repetir em toda mensagem só polui o chat.
  async onCustomerMessage(conversationId: string, text: string, channel: ChannelName): Promise<void> {
    const body = [
      `👤 Cliente (${CHANNEL_LABEL[channel]}): ${truncate(sanitizeQuoted(text), 3500)}`,
      formatConversationMarker(conversationId),
    ].join("\n");
    await this.sendToAttendants(body, conversationId, false);
  }
}
