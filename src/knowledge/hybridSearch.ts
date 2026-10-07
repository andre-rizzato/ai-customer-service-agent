// Reciprocal Rank Fusion — porta TypeScript de
// CursoClaude/ai/week11/hybrid_search.py e do mesmo algoritmo do AgentService
// irmão (rag/hybrid.py). Combina o ranking semântico (Qdrant) e o ranking
// BM25 SEM somar os scores brutos: cosseno vive entre -1 e 1, BM25 não tem
// teto — somar direto deixaria o BM25 dominar por acidente de escala, não
// por ser de fato mais relevante. RRF ignora o VALOR do score e usa só a
// POSIÇÃO de cada documento em cada ranking.
//
// Limitação conhecida, documentada no curso (week11) e no AgentService
// irmão: se um dos rankings empata (ex.: todo score BM25 sai 0.0 porque
// nenhum termo da query aparece em nenhum doc), a ordem de desempate é
// arbitrária e o RRF trata essa posição como sinal real, com peso cheio —
// é exatamente por isso que o reranker (reranker.ts) existe como próxima
// camada, não uma redundante: ele julga cada documento direto contra a
// query, sem etapa de combinação de ranking pra contaminar.

// Preâmbulo: reciprocalRankFusion() recebe várias listas (score, índice) JÁ
// ordenadas (o valor do score é ignorado aqui, só a posição na lista
// importa) e devolve uma lista combinada (rrfScore, índice), ordenada do
// maior pro menor. k=60 é a constante de amortecimento padrão do RRF: sem
// ela, um documento que é #1 em só UM dos rankings dominaria demais sobre
// um que está bem posicionado nos DOIS.
export function reciprocalRankFusion(rankings: [number, number][][], k = 60): [number, number][] {
  const rrfScores = new Map<number, number>();
  for (const ranking of rankings) {
    ranking.forEach(([, index], position) => {
      // position+1 porque enumera a partir de 1 (1º lugar), não de 0.
      const current = rrfScores.get(index) ?? 0;
      rrfScores.set(index, current + 1 / (k + position + 1));
    });
  }

  return [...rrfScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([index, score]) => [score, index]);
}
