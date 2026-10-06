// "Sessão atual" de uma conversa: os turnos DEPOIS do último atendimento
// humano encerrado. Criado em 06/10/2026 por dois bugs com a mesma raiz,
// ambos vistos em produção na mesma conversa:
//  1. Depois de o atendente encerrar o atendimento, o cliente clicou
//     "Nossos serviços" e o bot transferiu de novo NA HORA, sem perguntar:
//     o LLM recebia o histórico inteiro e via um "sim, pode transferir" de
//     um atendimento JÁ encerrado.
//  2. O alerta de handoff no Telegram listava mensagens desse atendimento
//     antigo, que o cliente nem via mais no widget — o atendente lia uma
//     conversa diferente da que o cliente estava tendo.
// O histórico completo continua gravado (auditoria, Mini App); este corte
// vale só pro que o LLM e o alerta enxergam.
import type { ConversationTurn } from "../types.js";

// Preâmbulo: isBoundary() diz se um turno marca o fim de um atendimento
// encerrado. O campo `contextBoundary` é o jeito certo (gravado por
// HumanRelay.close a partir de 06/10/2026). A comparação pelo texto da nota
// cobre os encerramentos gravados ANTES do campo existir — sem ela, a
// conversa que revelou o bug continuaria com o histórico antigo.
function isBoundary(turn: ConversationTurn): boolean {
  return turn.contextBoundary === true || (turn.role === "system-note" && turn.text.startsWith("Atendimento encerrado"));
}

// Preâmbulo: currentSession() devolve os turnos depois do último ponto de
// corte (ou o histórico inteiro, se nunca houve encerramento). Chamada pelo
// Orchestrator ao montar o histórico do LLM e pelo TelegramNotifier ao montar
// o alerta. "Devolver ao bot" NÃO grava ponto de corte de propósito: ali a
// conversa continua e o bot precisa saber o que o atendente disse.
export function currentSession(history: ConversationTurn[]): ConversationTurn[] {
  for (let i = history.length - 1; i >= 0; i--) {
    if (isBoundary(history[i])) return history.slice(i + 1);
  }
  return history;
}
