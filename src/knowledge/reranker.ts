// Wrapper fino sobre a API de Rerank hospedada da Voyage — porta
// TypeScript de CursoClaude/ai/week12/reranking.py e do mesmo wrapper do
// AgentService irmão (rag/reranker.py). Mesmo estilo de chamada HTTP direta
// (fetch, sem SDK) de voyageEmbeddings.ts, pelo mesmo motivo: a API é um
// único endpoint REST simples, não vale a pena uma dependência nova só por
// isso.
//
// Reranker é um CROSS-encoder: diferente do embedding (bi-encoder, que
// embeda query e documento SEPARADOS e compara os vetores depois), o
// cross-encoder lê query+documento JUNTOS numa passada só e devolve direto
// um score de relevância pro par. Mais caro por documento (nada pode ser
// pré-computado — a representação do documento só existe depois que a query
// chega), mais preciso, porque o modelo vê a interação real entre os dois
// textos em vez de comparar dois vetores que nunca se viram. Por isso só
// roda sobre um conjunto PEQUENO (o top-N do RRF, não o catálogo inteiro).
//
// Endpoint: mesmo host de voyageEmbeddings.ts (ai.mongodb.com, não
// api.voyageai.com) — confirmado rodando contra a API de verdade com a
// chave real do Key Vault: api.voyageai.com devolve 403 "This API key
// cannot access this endpoint" pra chaves emitidas via console do Atlas
// (mesma causa documentada no comentário de voyageEmbeddings.ts).
import { recordUsage } from "../usage/usageMeter.js";

const VOYAGE_RERANK_URL = "https://ai.mongodb.com/v1/rerank";

interface RerankResponseItem {
  relevance_score: number;
  index: number;
}

// Preâmbulo: rerank() reordena `documents` contra `query` usando o modelo
// rerank-2 da Voyage. Devolve pares (score, índiceOriginal) já ordenados
// pela própria API (decrescente) — diferente de bm25Rank()/
// reciprocalRankFusion() acima, não precisa reordenar na mão aqui.
export async function rerank(
  apiKey: string,
  query: string,
  documents: string[],
  topK?: number
): Promise<[number, number][]> {
  if (documents.length === 0) return [];

  const res = await fetch(VOYAGE_RERANK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      documents,
      model: "rerank-2",
      ...(topK !== undefined ? { top_k: topK } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Voyage rerank request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { data: RerankResponseItem[]; usage?: { total_tokens: number } };
  // Registra o consumo do rerank (ver src/usage/usageMeter.ts). O rerank
  // cobra pelos tokens da pergunta + TODOS os documentos candidatos — é por
  // isso que ele roda só sobre o top-N do RRF (CANDIDATE_POOL_SIZE em
  // knowledgeBase.ts), e este registro permite conferir quanto isso pesa.
  if (data.usage) {
    recordUsage({ kind: "rerank", provider: "voyage", model: "rerank-2", purpose: "rerank", inputTokens: data.usage.total_tokens });
  }
  // .index é a posição do documento na lista ORIGINAL `documents` passada —
  // não um id novo inventado pela Voyage — mesma garantia de
  // bm25Rank()/qdrantStore.query() (tudo endereçado por índice, nunca por
  // igualdade de texto).
  return data.data.map((d) => [d.relevance_score, d.index]);
}
