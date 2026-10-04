// Testes do cache de deduplicação (src/orchestrator/dedupeCache.ts) — item
// #1 da revisão de segurança de 04/10/2026 (docs/SECURITY_REVIEW.md). Cobre
// as duas garantias que a classe promete: a primeira vez que um id aparece
// ele passa, e uma reentrega do mesmo id dentro da janela de TTL é
// detectada — sem isso, uma reentrega de webhook (Meta ou Telegram)
// processaria a mesma mensagem duas vezes.
import { describe, expect, it, vi } from "vitest";
import { DedupeCache } from "../src/orchestrator/dedupeCache.js";

describe("DedupeCache (revisão de segurança item #1 — reentrega de webhook)", () => {
  // Preâmbulo: a primeira vez que um id é visto, hasSeenAndRecord() precisa
  // devolver false (não é uma reentrega) — é essa resposta que o
  // ChannelAdapter usa para decidir se deve ou não chamar o Orchestrator.
  it("returns false the first time an id is seen", () => {
    const cache = new DedupeCache(10_000);
    expect(cache.hasSeenAndRecord("wamid.ABC123")).toBe(false);
  });

  // Preâmbulo: chamar de novo com o MESMO id, ainda dentro do TTL, precisa
  // devolver true — é o caso real de reentrega (Meta/Telegram reenviando o
  // mesmo webhook por timeout de rede do lado deles).
  it("returns true for a repeated id within the TTL window", () => {
    const cache = new DedupeCache(10_000);
    cache.hasSeenAndRecord("wamid.ABC123");
    expect(cache.hasSeenAndRecord("wamid.ABC123")).toBe(true);
  });

  // Preâmbulo: ids diferentes nunca devem interferir entre si — confirma
  // que o Map interno usa o id como chave, não algum contador global.
  it("tracks each id independently", () => {
    const cache = new DedupeCache(10_000);
    expect(cache.hasSeenAndRecord("id-1")).toBe(false);
    expect(cache.hasSeenAndRecord("id-2")).toBe(false);
    expect(cache.hasSeenAndRecord("id-1")).toBe(true);
  });

  // Preâmbulo: depois que o TTL expira, o mesmo id deve ser tratado como
  // novo de novo — usa vi.useFakeTimers() para avançar o relógio sem
  // precisar de um sleep real no teste (manteria a suíte lenta à toa).
  it("forgets an id once its TTL has elapsed", () => {
    vi.useFakeTimers();
    try {
      const cache = new DedupeCache(1_000);
      expect(cache.hasSeenAndRecord("id-1")).toBe(false);
      vi.advanceTimersByTime(1_001);
      expect(cache.hasSeenAndRecord("id-1")).toBe(false);
    } finally {
      // Sempre restaura os timers reais, mesmo se uma asserção acima
      // falhar — senão o fake timer vazaria para os próximos testes do
      // mesmo arquivo/worker.
      vi.useRealTimers();
    }
  });
});
