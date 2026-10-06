// Factory de HandoffNotifier — mesmo padrão das factories de embeddings e
// LLM: único lugar que decide, a partir de agentConfig.handoffNotifier
// (vindo de agent.config.json, não do .env — é uma escolha do NEGÓCIO, não
// um segredo de ambiente), qual implementação instanciar.
import { agentConfig, env } from "../config.js";
import { attendantChatIds, deskBotToken } from "../handoff/attendants.js";
import { ConsoleNotifier } from "./consoleNotifier.js";
import { TelegramNotifier } from "./telegramNotifier.js";
import { WebhookNotifier } from "./webhookNotifier.js";
import type { HandoffNotifier } from "./types.js";

// Preâmbulo: createHandoffNotifier() constrói a implementação apropriada de
// HandoffNotifier. Chamada pelo Orchestrator na inicialização e de novo em
// reloadConfig() quando a tela de configuração troca o tipo de notifier.
export function createHandoffNotifier(): HandoffNotifier {
  switch (agentConfig.handoffNotifier) {
    case "webhook":
      // env.HANDOFF_WEBHOOK_URL! (non-null assertion): seguro aqui porque
      // src/config.ts já valida, na inicialização do processo, que
      // HANDOFF_WEBHOOK_URL existe sempre que agentConfig.handoffNotifier
      // é "webhook" — se essa invariante for quebrada, o processo já teria
      // falhado antes de chegar a esta linha.
      return new WebhookNotifier(env.HANDOFF_WEBHOOK_URL!);
    case "telegram":
      // Mesma garantia: validateCrossConfig() (src/config.ts) recusa
      // "telegram" sem TELEGRAM_BOT_TOKEN e sem HANDOFF_TELEGRAM_CHAT_IDS —
      // tanto no boot quanto num save pela tela de configuração.
      // deskBotToken (06/10/2026): o alerta sai pelo bot do ATENDENTE — que é
      // o bot de HANDOFF_TELEGRAM_BOT_TOKEN quando existe um separado, ou o
      // mesmo bot de clientes quando não (ver src/handoff/attendants.ts).
      return new TelegramNotifier(deskBotToken!, attendantChatIds, env.PUBLIC_BASE_URL);
    case "console":
      return new ConsoleNotifier();
  }
}

// Reexporta o tipo para quem quiser importar a partir desta fachada.
export type { HandoffNotifier } from "./types.js";
