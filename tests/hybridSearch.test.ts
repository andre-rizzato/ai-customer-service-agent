// Testes do Reciprocal Rank Fusion (src/knowledge/hybridSearch.ts) — função
// pura, mesma filosofia de testabilidade de bm25.test.ts.
import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "../src/knowledge/hybridSearch.js";

describe("reciprocalRankFusion", () => {
  it("documento bem posicionado nos DOIS rankings vence um que é 1º em só um deles", () => {
    // índice 0: 1º no ranking A, ausente do ranking B.
    // índice 1: 2º nos dois rankings.
    const rankingA: [number, number][] = [
      [0.9, 0],
      [0.5, 1],
    ];
    const rankingB: [number, number][] = [
      [0.8, 2],
      [0.6, 1],
    ];
    const fused = reciprocalRankFusion([rankingA, rankingB]);
    const topIndex = fused[0][1];
    expect(topIndex).toBe(1);
  });

  it("ignora o VALOR do score, só a posição importa", () => {
    // Mesma posição (1º lugar), valores de score bem diferentes - RRF deve
    // tratar os dois como equivalentes nessa única lista.
    const rankingHighScore: [number, number][] = [[999, 0]];
    const rankingLowScore: [number, number][] = [[0.001, 0]];
    const fusedHigh = reciprocalRankFusion([rankingHighScore]);
    const fusedLow = reciprocalRankFusion([rankingLowScore]);
    expect(fusedHigh[0][0]).toBe(fusedLow[0][0]);
  });
});
