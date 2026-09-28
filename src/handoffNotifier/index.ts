// Factory de HandoffNotifier — mesmo padrão das factories de embeddings e
// LLM: único lugar que decide, a partir de agentConfig.handoffNotifier
// (vindo de agent.config.json, não do .env — é uma escolha do NEGÓCIO, não
// um segredo de ambiente), qual implementação instanciar.
import { agentConfig, env } from "../config.js";
import { ConsoleNotifier } from "./consoleNotifier.js";
import { WebhookNotifier } from "./webhookNotifier.js";
import type { HandoffNotifier } from "./types.js";

// Preâmbulo: createHandoffNotifier() constrói a implementação apropriada de
// HandoffNotifier. Chamada uma vez pelo Orchestrator na inicialização.
export function createHandoffNotifier(): HandoffNotifier {
  switch (agentConfig.handoffNotifier) {
    case "webhook":
      // env.HANDOFF_WEBHOOK_URL! (non-null assertion): seguro aqui porque
      // src/config.ts já valida, na inicialização do processo, que
      // HANDOFF_WEBHOOK_URL existe sempre que agentConfig.handoffNotifier
      // é "webhook" — se essa invariante for quebrada, o processo já teria
      // falhado antes de chegar a esta linha.
      return new WebhookNotifier(env.HANDOFF_WEBHOOK_URL!);
    case "console":
      return new ConsoleNotifier();
  }
}

// Reexporta o tipo para quem quiser importar a partir desta fachada.
export type { HandoffNotifier } from "./types.js";
