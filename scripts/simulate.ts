// Script de linha de comando para "conversar" com o agente diretamente no
// terminal, sem precisar configurar nenhum canal real (Telegram/WhatsApp).
// Corresponde à Fase 5 do runbook ("Testes antes de ir ao ar") — é a
// ferramenta pensada para rodar manualmente a matriz de testes (pergunta
// dentro do escopo, fora do escopo, "você é IA?", pedido de humano,
// reclamação, mensagem ambígua) antes de conectar um canal de verdade.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomUUID } from "node:crypto";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";

// Preâmbulo: main() sobe um Orchestrator local e entra em um loop
// infinito lendo uma linha do terminal por vez, tratando cada linha como
// uma mensagem de um único usuário simulado. É o ponto de entrada do
// script (chamado no final do arquivo).
async function main() {
  // Mesma classe usada em produção (src/server.ts) — reaproveitar
  // Orchestrator aqui garante que o comportamento testado no terminal seja
  // idêntico ao que rodaria atrás de um canal real, já que nenhum adapter
  // de canal altera a lógica de negócio.
  const orchestrator = new Orchestrator();
  // Gera um conversationId único por execução do script, prefixado com
  // "sim-" para ser fácil de reconhecer no histórico/log de auditoria
  // gerado durante testes manuais (e não confundir com conversas reais de
  // um canal de produção).
  const conversationId = `sim-${randomUUID()}`;
  // Interface de leitura de linha do Node — permite usar `await
  // rl.question(...)` para pausar o script até o usuário digitar algo e
  // apertar Enter, em vez de lidar manualmente com eventos de stdin.
  const rl = createInterface({ input: stdin, output: stdout });

  console.log(`Conversa simulada iniciada (id=${conversationId}). Ctrl+C para sair.\n`);

  // Loop infinito: cada iteração é um turno de conversa. Só termina quando
  // o processo é interrompido (Ctrl+C) — não há uma condição de saída
  // programática porque este é um script interativo de teste manual.
  while (true) {
    // Bloqueia esperando o usuário digitar uma linha e apertar Enter.
    const text = await rl.question("você> ");
    // Ignora linhas vazias (Enter sem digitar nada) — não faz sentido
    // mandar uma mensagem em branco para o Orchestrator.
    if (!text.trim()) continue;
    // Chama exatamente o mesmo método que qualquer ChannelAdapter chamaria
    // em produção, montando um InboundMessage "na mão" com channel "web"
    // (não existe um canal "simulate" dedicado — reaproveitamos "web" por
    // não ter nenhum efeito colateral especial associado a esse valor).
    const reply = await orchestrator.handleMessage({
      channel: "web",
      userId: conversationId,
      conversationId,
      text,
      timestamp: Date.now(),
    });
    console.log(`agente> ${reply}\n`);
  }
}

// Executa main() e, se algo lançar (ex.: falha ao carregar configuração,
// erro de API), imprime o erro e encerra o processo com código de saída 1
// — mesmo padrão usado em src/knowledge/ingest.ts.
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
