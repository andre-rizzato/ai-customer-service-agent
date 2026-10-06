// Contrato comum para "avisar um humano que uma conversa precisa de
// atenção" — o Orchestrator depende só desta interface, permitindo trocar
// entre avisar no console (dev), via webhook do Slack/Discord/etc. e via
// Telegram com relay de resposta (produção) apenas mudando
// agent.config.json, sem tocar no pipeline.
import type { ChannelName, ConversationTurn, Language } from "../types.js";
import type { HandoffReason } from "../orchestrator/handoff.js";

// Por que um atendimento humano terminou (05/10/2026): "attendant" = o
// atendente apertou "Encerrar atendimento"; "inactivity" = ninguém falou
// nada por handoffInactivityMinutes (ver HumanRelay.closeInactive()).
export type HandoffCloseReason = "attendant" | "inactivity";

export interface HandoffNotifier {
  // Chamado uma vez toda vez que um handoff dispara. Recebe o histórico
  // completo da conversa até aqui — corresponde ao requisito da Fase 1 do
  // runbook: "o atendente humano recebe a conversa pronta, não 'oi, me
  // chamaram aqui'". `channel` entrou em 05/10/2026 junto com o relay
  // (src/handoff/relay.ts): o atendente precisa saber se está falando com
  // alguém no widget do site, no WhatsApp ou no Telegram.
  // `language` (06/10/2026, opcional): idioma do cliente, pra o atendente
  // saber em que língua responder (o relay não traduz nada).
  notify(conversationId: string, reason: HandoffReason, history: ConversationTurn[], channel: ChannelName, language?: Language): Promise<void>;

  // Chamado pra CADA mensagem nova que o cliente manda enquanto a conversa
  // está em handoff (PASSO 0 do Orchestrator — bot silenciado). Opcional
  // porque só faz sentido pra notifiers que sustentam uma conversa de ida e
  // volta (hoje, o TelegramNotifier): um Incoming Webhook do Slack só avisa
  // uma vez, o atendente continua o atendimento por fora e não precisa de
  // cada mensagem repassada. Sem este hook, num relay o atendente só veria
  // a primeira mensagem do cliente e nunca as respostas dele.
  onCustomerMessage?(conversationId: string, text: string, channel: ChannelName): Promise<void>;

  // Chamado quando um atendimento humano é ENCERRADO (não quando é só
  // devolvido ao bot). Opcional pelo mesmo motivo de onCustomerMessage: só
  // faz sentido pra quem sustenta a conversa com o atendente. Importa
  // principalmente no encerramento por inatividade — o atendente não
  // apertou nada e precisa saber que aquela conversa não está mais com ele.
  onHandoffClosed?(conversationId: string, channel: ChannelName, reason: HandoffCloseReason): Promise<void>;
}
