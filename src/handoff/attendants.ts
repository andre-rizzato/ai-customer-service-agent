// Peças compartilhadas do "balcão do atendente" no Telegram (relay de
// handoff, Opção B do item #5 de docs/SECURITY_REVIEW.md, construída em
// 05/10/2026): quem é atendente, e como uma mensagem do bot carrega o id da
// conversa do cliente pra que o atendente possa simplesmente responder
// (reply) a ela. Vive num módulo próprio, sem dependência de rede, porque é
// usado por três lados (TelegramNotifier escreve o marcador, TelegramDesk lê,
// server.ts confere a allowlist no Mini App) e porque é a parte mais
// sensível a erro de segurança — fica fácil de testar isolada
// (tests/handoffRelay.test.ts).
import { env } from "../config.js";

// Prefixo da linha que identifica a conversa em toda mensagem que o bot
// manda pro atendente. Emoji em vez de texto ("ID:") porque é visualmente
// distinto no Telegram e improvável de aparecer por acaso numa linha de
// texto normal — mas NÃO dá pra confiar só nisso (o cliente pode digitar o
// emoji de propósito), ver sanitizeQuoted() e extractConversationId().
export const CONVERSATION_MARKER = "🆔";

// Preâmbulo: parseAttendantChatIds() transforma a string do .env
// (HANDOFF_TELEGRAM_CHAT_IDS="123,456") num Set de chat ids. Set (e não
// array) porque a pergunta feita a cada update recebido é sempre "este chat
// id é de um atendente?" — O(1) e sem duplicatas se alguém repetir um id.
// Exportada separada da constante abaixo pra ser testável sem mexer no env.
export function parseAttendantChatIds(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

// Allowlist calculada uma vez na inicialização — só muda editando o .env e
// reiniciando, de propósito: quem pode responder clientes em nome da
// empresa não deve ser alterável pela tela de configuração (que não tem
// autenticação, ver POST /api/config em server.ts).
export const attendantChatIds = parseAttendantChatIds(env.HANDOFF_TELEGRAM_CHAT_IDS);

// Preâmbulo: formatConversationMarker() monta a linha final de toda mensagem
// do bot pro atendente. SEMPRE a última linha — extractConversationId()
// depende disso.
export function formatConversationMarker(conversationId: string): string {
  return `${CONVERSATION_MARKER} ${conversationId}`;
}

// Preâmbulo: sanitizeQuoted() limpa um texto escrito pelo CLIENTE antes de
// ele ser citado numa mensagem pro atendente (histórico no alerta, repasse
// de mensagem nova). Sem isto, um cliente mal-intencionado poderia digitar
// "\n🆔 <id de outra conversa>" e, se o atendente respondesse àquela
// mensagem, a resposta poderia ir parar na conversa de OUTRA pessoa. Trocar
// o emoji neutraliza qualquer linha falsa; extractConversationId() ainda
// pega só a última ocorrência como segunda camada de defesa.
export function sanitizeQuoted(text: string): string {
  return text.replaceAll(CONVERSATION_MARKER, "[id]");
}

// Preâmbulo: extractConversationId() lê o id da conversa a partir do texto
// de uma mensagem do bot à qual o atendente respondeu (reply_to_message do
// Telegram). Stateless de propósito — nenhum mapa "message_id -> conversa"
// guardado em disco/memória: o próprio texto da mensagem, que só o bot pode
// ter escrito (TelegramDesk confere reply_to_message.from.is_bot), já
// carrega a informação, e isso sobrevive a restart do processo sem custo.
// Pega a ÚLTIMA ocorrência (o marcador é sempre a última linha que o bot
// escreve) — mesmo que um texto citado escapasse da sanitização, ele estaria
// ANTES do marcador verdadeiro.
export function extractConversationId(text: string | undefined): string | null {
  if (!text) return null;
  const matches = [...text.matchAll(new RegExp(`^${CONVERSATION_MARKER} (\\S+)\\s*$`, "gmu"))];
  const last = matches.at(-1);
  return last ? last[1] : null;
}
