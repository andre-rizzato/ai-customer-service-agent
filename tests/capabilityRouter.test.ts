// Testes do roteador de capacidade (src/orchestrator/capabilityRouter.ts).
// Mesmo espírito de handoff.test.ts: cobre a parte determinística (detecção
// por palavra-chave), sem chamar o AgentService de verdade — isso é
// responsabilidade de orchestrator.ts (testado manualmente via `npm run
// simulate` com AGENT_SERVICE_URL apontando pro FastAPI local).
import { describe, expect, it } from "vitest";
import { detectCapability } from "../src/orchestrator/capabilityRouter.js";

describe("detectCapability", () => {
  // Preâmbulo: config/agent.config.example.json (usado nos testes, ver
  // vitest.config.ts) tem "order" em enabledCapabilities e "status do
  // pedido" em orderKeywords — confirma que uma pergunta de pedido real é
  // roteada pra "order" em vez de cair no RAG normal.
  it("detects an order-status question", () => {
    expect(detectCapability("qual o status do meu pedido 12345?")).toBe("order");
  });

  it("detects a scheduling question", () => {
    expect(detectCapability("gostaria de marcar um horário pra amanhã")).toBe("scheduling");
  });

  it("detects a sales question", () => {
    expect(detectCapability("quero comprar o produto X")).toBe("sales");
  });

  // Preâmbulo: mesma checagem de normalize() que handoff.test.ts já faz —
  // capabilityRouter reusa a MESMA função (ver handoff.ts), então cobrir
  // isso aqui de novo é sobre o fio entre os dois módulos, não duplicar
  // teste de normalize() em si.
  it("is case-insensitive and accent-insensitive", () => {
    expect(detectCapability("STATUS DO PEDIDO 999")).toBe("order");
  });

  it("returns null for an in-scope product question", () => {
    expect(detectCapability("qual a voltagem do filtro FX200?")).toBeNull();
  });

  // Preâmbulo: prioridade quando a mensagem bate em mais de uma lista —
  // order é checado primeiro em detectCapability() (ver comentário lá), uma
  // escolha arbitrária mas determinística; este teste documenta esse
  // comportamento pra não virar surpresa se a ordem mudar sem querer.
  it("prioritizes order over scheduling/sales when a message matches both", () => {
    expect(detectCapability("quero cancelar pedido e também marcar horário")).toBe("order");
  });
});
