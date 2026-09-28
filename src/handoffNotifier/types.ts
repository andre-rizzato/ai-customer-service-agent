// Contrato comum para "avisar um humano que uma conversa precisa de
// atenção" — o Orchestrator depende só desta interface, permitindo trocar
// entre avisar no console (dev) e avisar via webhook do Slack/Discord/etc.
// (produção) apenas mudando agent.config.json, sem tocar no pipeline.
import type { ConversationTurn } from "../types.js";
import type { HandoffReason } from "../orchestrator/handoff.js";

export interface HandoffNotifier {
  // Chamado uma vez toda vez que um handoff dispara. Recebe o histórico
  // completo da conversa até aqui — corresponde ao requisito da Fase 1 do
  // runbook: "o atendente humano recebe a conversa pronta, não 'oi, me
  // chamaram aqui'".
  notify(conversationId: string, reason: HandoffReason, history: ConversationTurn[]): Promise<void>;
}
