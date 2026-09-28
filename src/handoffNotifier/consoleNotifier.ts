// Implementação de HandoffNotifier que só imprime no terminal — pensada
// para desenvolvimento local e para o script de simulação (scripts/
// simulate.ts), onde não existe nenhum humano real de plantão esperando um
// alerta de Slack. É a implementação padrão (agentConfig.handoffNotifier =
// "console" por default em config/agent.config.example.json).
import type { ConversationTurn } from "../types.js";
import type { HandoffReason } from "../orchestrator/handoff.js";
import type { HandoffNotifier } from "./types.js";

// Preâmbulo: ConsoleNotifier implementa HandoffNotifier escrevendo no
// stdout do processo. Instanciada por src/handoffNotifier/index.ts quando
// agentConfig.handoffNotifier === "console".
export class ConsoleNotifier implements HandoffNotifier {
  // Preâmbulo: notify() é chamado pelo Orchestrator toda vez que
  // detectHandoffTrigger() encontra um gatilho — aqui, simplesmente formata
  // e imprime a conversa inteira no console, simulando o que um atendente
  // humano precisaria ver ao assumir a conversa.
  async notify(conversationId: string, reason: HandoffReason, history: ConversationTurn[]): Promise<void> {
    // Cabeçalho identificando qual conversa disparou o handoff e por quê —
    // útil para grep/busca em logs de terminal durante testes manuais.
    console.log(`\n[HANDOFF] conversation=${conversationId} reason=${reason}`);
    console.log("--- histórico anexado ---");
    // Imprime cada turno na ordem em que aconteceu, no formato "papel:
    // texto" — é a versão "console" de anexar o histórico completo ao
    // atendente humano (Fase 1: "recebe a conversa pronta").
    for (const turn of history) {
      console.log(`${turn.role}: ${turn.text}`);
    }
    console.log("--- fim do histórico ---\n");
  }
}
