// Implementação de HandoffNotifier que só imprime no terminal — pensada
// para desenvolvimento local e para o script de simulação (scripts/
// simulate.ts), onde não existe nenhum humano real de plantão esperando um
// alerta de Slack. É a implementação padrão (agentConfig.handoffNotifier =
// "console" por default em config/agent.config.example.json).
import type { ChannelName, ConversationTurn } from "../types.js";
import type { HandoffReason } from "../orchestrator/handoff.js";
import type { HandoffCloseReason, HandoffNotifier } from "./types.js";

// Preâmbulo: ConsoleNotifier implementa HandoffNotifier escrevendo no
// stdout do processo. Instanciada por src/handoffNotifier/index.ts quando
// agentConfig.handoffNotifier === "console".
export class ConsoleNotifier implements HandoffNotifier {
  // Preâmbulo: notify() é chamado pelo Orchestrator toda vez que
  // detectHandoffTrigger() encontra um gatilho — aqui, simplesmente formata
  // e imprime a conversa inteira no console, simulando o que um atendente
  // humano precisaria ver ao assumir a conversa.
  async notify(conversationId: string, reason: HandoffReason, history: ConversationTurn[], channel: ChannelName): Promise<void> {
    // Cabeçalho identificando qual conversa disparou o handoff, de qual
    // canal e por quê — útil para grep/busca em logs de terminal durante
    // testes manuais.
    console.log(`\n[HANDOFF] conversation=${conversationId} channel=${channel} reason=${reason}`);
    console.log("--- histórico anexado ---");
    // Imprime cada turno na ordem em que aconteceu, no formato "papel:
    // texto" — é a versão "console" de anexar o histórico completo ao
    // atendente humano (Fase 1: "recebe a conversa pronta").
    for (const turn of history) {
      console.log(`${turn.role}: ${turn.text}`);
    }
    console.log("--- fim do histórico ---\n");
  }

  // Preâmbulo: onCustomerMessage() é chamado pelo Orchestrator (PASSO 0)
  // pra cada mensagem do cliente durante o handoff — no console só registra
  // uma linha, o suficiente pra testar localmente que o hook está sendo
  // disparado sem precisar de um bot do Telegram configurado.
  async onCustomerMessage(conversationId: string, text: string, channel: ChannelName): Promise<void> {
    console.log(`[HANDOFF] conversation=${conversationId} channel=${channel} cliente: ${text}`);
  }

  // Preâmbulo: onHandoffClosed() — uma linha no console quando um
  // atendimento é encerrado, pra testar o encerramento (inclusive por
  // inatividade) localmente sem bot do Telegram.
  async onHandoffClosed(conversationId: string, channel: ChannelName, reason: HandoffCloseReason): Promise<void> {
    console.log(`[HANDOFF] conversation=${conversationId} channel=${channel} encerrado (${reason})`);
  }
}
