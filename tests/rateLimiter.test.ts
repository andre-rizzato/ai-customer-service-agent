// Testes do limitador de taxa (src/orchestrator/rateLimiter.ts) — cobre o
// item do checklist da Fase 6 do runbook sobre evitar custo descontrolado
// em caso de mensagens em loop.
import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/orchestrator/rateLimiter.js";

describe("RateLimiter (Fase 6 — evitar custo descontrolado em loop)", () => {
  // Preâmbulo: com um limite de 3 mensagens por janela, as 3 primeiras
  // chamadas para a mesma conversa devem ser permitidas.
  it("allows messages up to the limit within the window", () => {
    const limiter = new RateLimiter(3, 60);
    expect(limiter.isAllowed("conv-1")).toBe(true);
    expect(limiter.isAllowed("conv-1")).toBe(true);
    expect(limiter.isAllowed("conv-1")).toBe(true);
  });

  // Preâmbulo: com um limite de 2, a terceira chamada dentro da mesma
  // janela de tempo deve ser bloqueada — confirma que o limite é
  // efetivamente aplicado, não só contado.
  it("blocks once the limit is exceeded within the same window", () => {
    const limiter = new RateLimiter(2, 60);
    limiter.isAllowed("conv-1");
    limiter.isAllowed("conv-1");
    expect(limiter.isAllowed("conv-1")).toBe(false);
  });

  // Preâmbulo: confirma que o contador é por conversationId — atingir o
  // limite em "conv-1" não deve afetar "conv-2", já que o Map interno usa o
  // conversationId como chave.
  it("tracks each conversation independently", () => {
    const limiter = new RateLimiter(1, 60);
    expect(limiter.isAllowed("conv-1")).toBe(true);
    expect(limiter.isAllowed("conv-2")).toBe(true);
    expect(limiter.isAllowed("conv-1")).toBe(false);
  });
});
