// Testes das três economias de custo de 09/10/2026: HyDE condicional
// (knowledgeBase.ts), cache do HyDE (hyde.ts) e janela de histórico
// (conversation/memory.ts). O que importa garantir: o HyDE só é pulado
// quando a busca simples achou algo com folga, pergunta repetida não paga
// o LLM duas vezes, e a janela nunca começa com fala do bot.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Estado compartilhado com os mocks — vi.hoisted porque vi.mock é içado
// pro topo do arquivo, antes de qualquer const comum.
const h = vi.hoisted(() => ({
  agentConfig: { topK: 3, minRelevanceScore: 0.4, hydeSkipScore: 0.5 },
  generate: vi.fn(),
  embed: vi.fn(),
  rerank: vi.fn(),
}));

vi.mock("../src/config.js", () => ({ agentConfig: h.agentConfig, env: { VOYAGE_API_KEY: "fake" } }));
vi.mock("../src/llm/index.js", () => ({ createLLMProvider: () => ({ generate: (...args: unknown[]) => h.generate(...args) }) }));
vi.mock("../src/embeddings/index.js", () => ({ createEmbeddingProvider: () => ({ embed: (...args: unknown[]) => h.embed(...args) }) }));
vi.mock("../src/knowledge/reranker.js", () => ({ rerank: (...args: unknown[]) => h.rerank(...args) }));
vi.mock("../src/knowledge/qdrantStore.js", () => ({
  query: async () => [
    { score: 0.9, item: { id: "a", title: "A", content: "frete grátis acima de 300" } },
    { score: 0.8, item: { id: "b", title: "B", content: "garantia de 12 meses" } },
  ],
}));

import { KnowledgeBase } from "../src/knowledge/knowledgeBase.js";
import { cacheKey, generateHypotheticalPassage } from "../src/knowledge/hyde.js";
import { splitWindow, type DialogueTurn } from "../src/conversation/memory.js";

beforeEach(() => {
  h.generate.mockReset().mockResolvedValue("passagem hipotética");
  h.embed.mockReset().mockResolvedValue([[0.1, 0.2]]);
  h.rerank.mockReset();
});

describe("HyDE condicional (KnowledgeBase.search)", () => {
  it("pula o HyDE quando a busca com a pergunta crua passa de hydeSkipScore", async () => {
    h.rerank.mockResolvedValue([[0.62, 0], [0.3, 1]]);
    const results = await new KnowledgeBase().search("tem frete grátis?");
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.embed).toHaveBeenCalledWith(["tem frete grátis?"]);
    // O corte de relevância continua valendo: 0.3 fica de fora.
    expect(results.map((r) => r.score)).toEqual([0.62]);
  });

  it("roda o HyDE quando a busca simples fica abaixo de hydeSkipScore, e reranka sempre contra a pergunta original", async () => {
    h.rerank.mockResolvedValueOnce([[0.45, 0]]).mockResolvedValueOnce([[0.58, 1]]);
    const results = await new KnowledgeBase().search("pergunta indireta única 1");
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.embed).toHaveBeenLastCalledWith(["passagem hipotética"]);
    expect(h.rerank.mock.calls.every((call) => call[1] === "pergunta indireta única 1")).toBe(true);
    expect(results.map((r) => r.item.id)).toEqual(["b"]);
  });
});

describe("cache do HyDE", () => {
  it("normaliza variações triviais da mesma pergunta", () => {
    expect(cacheKey("  Tem frete GRÁTIS?? ")).toBe(cacheKey("tem frete gratis"));
  });

  it("não chama o LLM de novo para pergunta repetida", async () => {
    await generateHypotheticalPassage("Qual o prazo de entrega?");
    await generateHypotheticalPassage("qual o prazo de entrega");
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it("não guarda passagem vazia", async () => {
    h.generate.mockResolvedValue("");
    await generateHypotheticalPassage("pergunta que falhou");
    await generateHypotheticalPassage("pergunta que falhou");
    expect(h.generate).toHaveBeenCalledTimes(2);
  });
});

describe("janela de histórico (splitWindow)", () => {
  const turn = (role: DialogueTurn["role"], text: string): DialogueTurn => ({ role, text, timestamp: 0 });
  const conversa = Array.from({ length: 10 }, (_, i) => turn(i % 2 === 0 ? "user" : "assistant", `t${i}`));

  it("mantém tudo quando a conversa cabe na janela", () => {
    expect(splitWindow(conversa, 15)).toEqual({ older: [], window: conversa });
  });

  it("corta os mais antigos e nunca começa a janela com fala do bot", () => {
    // Últimos 5 = t5(assistant)..t9 -> t5 vai pra "antigos".
    const { older, window } = splitWindow(conversa, 5);
    expect(window.map((t) => t.text)).toEqual(["t6", "t7", "t8", "t9"]);
    expect(older.map((t) => t.text)).toEqual(["t0", "t1", "t2", "t3", "t4", "t5"]);
  });

  it("trata fala do atendente humano como não-cliente no começo da janela", () => {
    const turns = [turn("user", "a"), turn("human-agent", "b"), turn("user", "c")];
    expect(splitWindow(turns, 2).window.map((t) => t.text)).toEqual(["c"]);
  });
});
