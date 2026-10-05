// Implementação de HandoffNotifier que dispara um POST HTTP para uma URL
// configurada — corresponde ao checklist da Fase 6 do runbook: "Alerta
// automático (e-mail ou Slack) quando o handoff dispara, para o humano não
// perder o gatilho." Usada em produção
// (agentConfig.handoffNotifier === "webhook").
import type { ChannelName, ConversationTurn } from "../types.js";
import type { HandoffReason } from "../orchestrator/handoff.js";
import type { HandoffNotifier } from "./types.js";

// Preâmbulo: WebhookNotifier implementa HandoffNotifier fazendo uma
// requisição HTTP para a URL recebida no construtor. Instanciada por
// src/handoffNotifier/index.ts quando agentConfig.handoffNotifier ===
// "webhook", com a URL vinda de env.HANDOFF_WEBHOOK_URL.
export class WebhookNotifier implements HandoffNotifier {
  constructor(private readonly url: string) {}

  // Preâmbulo: notify() é chamado pelo Orchestrator toda vez que um
  // gatilho de handoff dispara — monta um payload JSON com o motivo e o
  // histórico completo da conversa e envia via POST para a URL configurada
  // (ex.: um Incoming Webhook do Slack, que exibe o campo `text` como
  // mensagem no canal).
  async notify(conversationId: string, reason: HandoffReason, history: ConversationTurn[], channel: ChannelName): Promise<void> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Campo `text` é reconhecido nativamente por Incoming Webhooks do
        // Slack/Discord como a mensagem a exibir; quem apontar
        // HANDOFF_WEBHOOK_URL para um endpoint próprio pode simplesmente
        // ignorar este campo e usar os demais.
        text: `Handoff (${reason}) na conversa ${conversationId} [${channel}]`,
        conversationId,
        // Canal de origem — campo novo (05/10/2026), aditivo: quem já
        // consome este payload e não conhece o campo simplesmente o ignora.
        channel,
        reason,
        // Histórico completo anexado — mesmo requisito da Fase 1 ("o
        // atendente humano recebe a conversa pronta") já comentado em
        // ConsoleNotifier, aqui entregue como dado estruturado em vez de
        // texto para console.
        history,
      }),
    });
    // Se a notificação falhar (URL errada, serviço fora do ar), registramos
    // no log do próprio processo em vez de lançar uma exceção — um alerta
    // de handoff que falha NÃO deveria impedir o Orchestrator de continuar
    // e enviar a resposta de "vou te conectar" ao usuário; se lançássemos
    // aqui, o `await` no Orchestrator propagaria o erro e a resposta nunca
    // seria enviada.
    if (!res.ok) {
      console.error(`Handoff webhook notify failed (${res.status}): ${await res.text().catch(() => "")}`);
    }
  }
}
