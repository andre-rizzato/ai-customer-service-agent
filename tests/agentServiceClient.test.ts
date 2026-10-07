// Guarda o contrato HTTP que este projeto envia PRO AgentService
// (DistributedOrderSystem/src/AgentService, Python). O comentário do
// próprio agentServiceClient.ts já declara a promessa: "este módulo só
// conhece o contrato HTTP... o AgentService podia trocar de LangGraph pra
// qualquer outra coisa sem este arquivo mudar uma linha" — este teste é o
// que torna essa promessa checável, não só um comentário em que confiar.
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mocka config.ts inteiro ANTES do import de agentServiceClient.ts (que lê
// env.AGENT_SERVICE_URL no momento da chamada) — evita depender de
// process.env/.env reais só pra rodar este teste.
vi.mock("../src/config.js", () => ({
  env: { AGENT_SERVICE_URL: "http://fake-agent-service:8100" },
}));

import { callAgentService } from "../src/orchestrator/agentServiceClient.js";

describe("callAgentService (contrato com AgentService)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("envia exatamente {message, session_id, requester_phone} pro endpoint /agent/message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ reply: "ok", intent: "general_question", confidence: 0.9 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await callAgentService("status do meu pedido", "sessao-1", "+5511999999999");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://fake-agent-service:8100/agent/message");
    expect(JSON.parse(init.body)).toEqual({
      message: "status do meu pedido",
      session_id: "sessao-1",
      requester_phone: "+5511999999999",
    });
  });

  it("devolve reply/intent/confidence/order_id da resposta", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ reply: "pedido cancelado", intent: "cancel_order", confidence: 0.98, order_id: "12345" }),
      })
    );

    const result = await callAgentService("cancela meu pedido", "sessao-2");

    expect(result).toEqual({
      reply: "pedido cancelado",
      intent: "cancel_order",
      confidence: 0.98,
      order_id: "12345",
    });
  });

  it("lança erro com o status e corpo quando a resposta não é 2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "internal error",
      })
    );

    await expect(callAgentService("oi", "sessao-3")).rejects.toThrow(/500/);
  });
});
