// Mensagens FIXAS que o bot manda ao cliente (sem passar pelo LLM), em cada
// idioma suportado. Criado em 06/10/2026: o site tem versões em português,
// inglês e italiano, mas todas as respostas saíam em português — o LLM não
// sabia em que idioma o cliente estava, e estas mensagens eram constantes em
// português dentro do orchestrator.ts. Concentrar tudo aqui faz "adicionar
// um idioma" ser uma mudança em um arquivo só.

// Idiomas suportados — os mesmos do site institucional (pt/en/it).
export type Language = "pt" | "en" | "it";

// Idioma usado quando o canal não informa nenhum (ou informa um que não
// suportamos): o público principal do produto é brasileiro.
export const DEFAULT_LANGUAGE: Language = "pt";

// Nome do idioma escrito EM PORTUGUÊS — usado no system prompt (que é todo em
// português) e no alerta pro atendente ("Idioma do cliente: inglês").
export const LANGUAGE_NAME: Record<Language, string> = {
  pt: "português",
  en: "inglês",
  it: "italiano",
};

// Preâmbulo: normalizeLanguage() transforma o que o canal manda num Language
// suportado, ou undefined. Aceita códigos completos ("pt-BR", "en-US",
// "it_IT") porque é isso que navegadores e o Telegram (`language_code`)
// mandam; só o prefixo de 2 letras importa. undefined (e não o padrão) de
// propósito: quem chama decide se cai no idioma já salvo da conversa ou no
// DEFAULT_LANGUAGE.
export function normalizeLanguage(raw: unknown): Language | undefined {
  if (typeof raw !== "string") return undefined;
  const code = raw.trim().slice(0, 2).toLowerCase();
  return code === "pt" || code === "en" || code === "it" ? code : undefined;
}

// Chaves das mensagens fixas. Os textos em português são exatamente os que
// já existiam (orchestrator.ts e relay.ts), pra não mudar nada pra quem já
// usa em português.
type MessageKey =
  | "handoff"
  | "rateLimit"
  | "capabilityNotWired"
  | "cancelOrderHandoff"
  | "closedByAttendant"
  | "closedByInactivity";

const MESSAGES: Record<MessageKey, Record<Language, string>> = {
  handoff: {
    pt: "Vou te conectar com um atendente humano para continuar essa conversa. Só um instante.",
    en: "I'll connect you with a human agent to continue this conversation. Just a moment.",
    it: "Ti metto in contatto con un operatore per continuare questa conversazione. Un attimo.",
  },
  rateLimit: {
    pt: "Recebi várias mensagens muito rápido e preciso desacelerar um pouco — me manda de novo em um minuto, por favor.",
    en: "I received several messages very quickly and need to slow down a bit — please send it again in a minute.",
    it: "Ho ricevuto molti messaggi in poco tempo e devo rallentare un po' — rimandamelo tra un minuto, per favore.",
  },
  capabilityNotWired: {
    pt: "Vou te conectar com um atendente humano para resolver isso com você. Só um instante.",
    en: "I'll connect you with a human agent to sort this out with you. Just a moment.",
    it: "Ti metto in contatto con un operatore per risolvere la cosa insieme. Un attimo.",
  },
  cancelOrderHandoff: {
    pt: "Entendi que você quer cancelar um pedido — para confirmar isso com segurança, vou te conectar com um atendente humano. Só um instante.",
    en: "I understand you want to cancel an order — to confirm this safely, I'll connect you with a human agent. Just a moment.",
    it: "Ho capito che vuoi annullare un ordine — per confermarlo in sicurezza, ti metto in contatto con un operatore. Un attimo.",
  },
  closedByAttendant: {
    pt: "Atendimento encerrado. Obrigado pelo contato! Se precisar de mais alguma coisa, é só mandar uma nova mensagem.",
    en: "This conversation has been closed. Thank you for reaching out! If you need anything else, just send a new message.",
    it: "Conversazione chiusa. Grazie per averci contattato! Se ti serve altro, basta inviare un nuovo messaggio.",
  },
  closedByInactivity: {
    pt: "Encerramos este atendimento por falta de interação. Se ainda precisar de ajuda, é só mandar uma nova mensagem.",
    en: "We closed this conversation due to inactivity. If you still need help, just send a new message.",
    it: "Abbiamo chiuso questa conversazione per inattività. Se hai ancora bisogno di aiuto, basta inviare un nuovo messaggio.",
  },
};

// Preâmbulo: message() devolve o texto fixo no idioma pedido, caindo no
// português se faltar tradução (não deveria, mas uma mensagem em português é
// melhor do que `undefined` chegando ao cliente).
export function message(key: MessageKey, language: Language | undefined): string {
  const lang = language ?? DEFAULT_LANGUAGE;
  return MESSAGES[key][lang] ?? MESSAGES[key][DEFAULT_LANGUAGE];
}
