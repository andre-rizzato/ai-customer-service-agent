// Guarda o contrato HTTP de /webhook/web — consumido pelo widget vendorizado
// do rizzatotech-site (useBffRouting: false, chatbotServiceUrl apontado pra
// cá) e pelo public/whatsapp.html deste próprio projeto. Dois formatos de
// payload aceitos no MESMO endpoint, resposta sempre espelhada em
// {reply, message} — nenhum destes dois formatos pode quebrar sem avisar o
// site/widget que depende deles. Nada neste trabalho de RAG toca
// src/channels/web.ts, mas o teste não existia antes e o contrato é frágil
// o bastante (dois formatos de entrada, dois nomes de saída) pra valer a
// pena travar agora.
import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { WebAdapter } from "../src/channels/web.js";

// Fabrica um objeto `res` mínimo compatível com o que handleWebhook() usa
// (`res.status(n).json(obj)` e `res.json(obj)`) — não precisa de um app
// Express real nem de supertest pra testar isso isoladamente.
function fakeResponse() {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res) as unknown as Response["status"];
  res.json = vi.fn() as unknown as Response["json"];
  return res;
}

describe("WebAdapter (contrato /webhook/web)", () => {
  it("aceita o formato nativo {conversationId, text}", async () => {
    const adapter = new WebAdapter();
    const req = { body: { conversationId: "c1", text: "oi" } } as Request;
    const res = fakeResponse();

    await adapter.handleWebhook(req, res, async () => "resposta do agente");

    expect(res.json).toHaveBeenCalledWith({ reply: "resposta do agente", message: "resposta do agente" });
  });

  it("aceita o formato do widget {sessionId, message} no MESMO endpoint", async () => {
    const adapter = new WebAdapter();
    const req = { body: { sessionId: "c1", message: "oi" } } as Request;
    const res = fakeResponse();

    await adapter.handleWebhook(req, res, async () => "resposta do agente");

    expect(res.json).toHaveBeenCalledWith({ reply: "resposta do agente", message: "resposta do agente" });
  });

  it("400 quando faltam os dois campos obrigatórios", async () => {
    const adapter = new WebAdapter();
    const req = { body: {} } as Request;
    const res = fakeResponse();

    await adapter.handleWebhook(req, res, async () => "não deveria chegar aqui");

    expect(res.status).toHaveBeenCalledWith(400);
  });
});
