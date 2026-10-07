// Testes do BM25 "na unha" (src/knowledge/bm25.ts) — função pura, sem
// chamada de rede, mesma filosofia de testabilidade de outros módulos
// determinísticos do projeto (ex.: capabilityRouter.test.ts).
import { describe, expect, it } from "vitest";
import { bm25Rank, tokenize } from "../src/knowledge/bm25.js";

describe("tokenize", () => {
  it("minúsculas, remove pontuação e descarta stopword", () => {
    expect(tokenize("O Filtro de Água FX200!")).toEqual(["filtro", "água", "fx200"]);
  });
});

describe("bm25Rank", () => {
  // Preâmbulo: termo raro e exato (um código de produto) deve vencer um
  // documento que só é "meio parecido" por falar do mesmo assunto genérico —
  // é exatamente o caso que a busca puramente semântica tende a errar (ver
  // o achado documentado em CursoClaude week11/AgentService rag/bm25.py).
  it("favorece o documento com o termo exato da query", () => {
    const docs = [
      "Filtro de água FX200. Tensão bivolt, preço R$ 349,90.",
      "Política de troca e devolução em até 7 dias corridos.",
      "Prazo de entrega: 3 a 7 dias úteis para capitais.",
    ];
    const ranked = bm25Rank("qual o preço do FX200", docs);
    // ranked[0] é [score, índice] — índice 0 é o doc do FX200.
    expect(ranked[0][1]).toBe(0);
  });

  it("empata em zero quando nenhum termo da query aparece em nenhum doc", () => {
    const docs = ["Filtro de água FX200.", "Política de troca."];
    const ranked = bm25Rank("xadrez astronomia", docs);
    expect(ranked[0][0]).toBe(0);
    expect(ranked[1][0]).toBe(0);
  });
});
