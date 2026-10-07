// Fachada de "busca na base de conhecimento" usada pelo Orchestrator — une
// Qdrant (armazenamento + busca semântica filtrada), BM25 (busca por
// palavra-chave), RRF (combina os dois) e reranking (Voyage rerank-2) num
// pipeline só, e aplica a "regra de vazio" da Fase 3 do runbook (descartar
// trechos pouco relevantes em vez de forçar o LLM a usar algo que não é
// realmente sobre a pergunta feita).
//
// Assinatura pública INALTERADA em relação à versão anterior (cosseno puro
// sobre FileVectorStore) — `new KnowledgeBase()` e `.search(query):
// Promise<RetrievedChunk[]>` continuam exatamente iguais, então
// orchestrator.ts e promptBuilder.ts não precisam mudar nenhuma linha. Por
// dentro, tudo mudou: mesma técnica do AgentService irmão
// (DistributedOrderSystem/src/AgentService/rag/retrieval.py), portada pra
// este catálogo genérico.
import { agentConfig, env } from "../config.js";
import { createEmbeddingProvider } from "../embeddings/index.js";
import { bm25Rank } from "./bm25.js";
import { reciprocalRankFusion } from "./hybridSearch.js";
import { generateHypotheticalPassage } from "./hyde.js";
import { rerank } from "./reranker.js";
import * as qdrantStore from "./qdrantStore.js";
import type { RetrievedChunk } from "../types.js";

// Quantos candidatos a busca semântica traz ANTES de BM25/RRF/rerank
// entrarem em ação — grande o bastante pra um trecho relevante que o
// cosseno colocou em 8º/9º lugar ainda ter chance de subir depois do
// rerank, pequeno o bastante pra manter a chamada de rerank (a etapa cara)
// rápida e barata. Mesmo valor do AgentService irmão.
const CANDIDATE_POOL_SIZE = 15;

export class KnowledgeBase {
  // Provider de embeddings especializado em "query" (pergunta do usuário),
  // distinto do provider "document" usado pelo script de ingest — mesma
  // explicação de sempre (ver embeddings/voyageEmbeddings.ts):
  // input_type diferente gera vetor ligeiramente diferente, mesmo espaço
  // vetorial.
  private readonly queryEmbedder = createEmbeddingProvider("query");

  constructor() {
    // Diferente da versão anterior (FileVectorStore lido do disco no
    // construtor), o Qdrant é um serviço remoto — não há "carregar índice"
    // síncrono aqui. Se a coleção não existir ainda (catálogo nunca
    // indexado), search() abaixo simplesmente não encontra nada; não há
    // como avisar no construtor sem uma chamada de rede, e isso tornaria
    // a inicialização do processo mais lenta/frágil por um aviso que o
    // operador só precisa ver uma vez (rodar `npm run ingest`).
  }

  // Preâmbulo: search() é o método público chamado pelo Orchestrator uma
  // vez por mensagem do usuário. Pipeline: HyDE -> embed -> busca semântica
  // no Qdrant -> BM25 -> RRF -> rerank -> corte de relevância mínima.
  async search(query: string): Promise<RetrievedChunk[]> {
    // HyDE só muda o que é EMBEDADO pra busca semântica — BM25 e o reranker
    // abaixo usam sempre a query ORIGINAL, nunca a passagem hipotética.
    // BM25 casa termo exato, que o vocabulário inventado da passagem só
    // atrapalharia; o reranker julga relevância de verdade contra o que o
    // cliente de fato perguntou, não contra um palpite descartável do LLM.
    const hypothetical = await generateHypotheticalPassage(query);
    const [queryVector] = await this.queryEmbedder.embed([hypothetical]);

    const semanticHits = await qdrantStore.query(queryVector, CANDIDATE_POOL_SIZE);
    if (semanticHits.length === 0) return [];

    // Texto usado pro BM25 é título+conteúdo concatenados — o MESMO texto
    // que ingest.ts embeda pra cada item (ver ingest.ts), pra manter os
    // dois métodos de ranking comparando o mesmo conteúdo.
    const candidateTexts = semanticHits.map((h) => `${h.item.title}\n${h.item.content}`);
    const semanticRanking: [number, number][] = semanticHits.map((h, i) => [h.score, i]);
    const bm25Ranking = bm25Rank(query, candidateTexts);

    const fused = reciprocalRankFusion([semanticRanking, bm25Ranking]);
    const fusedChunks = fused.map(([, i]) => semanticHits[i]);
    const fusedTexts = fused.map(([, i]) => candidateTexts[i]);

    // Reranking é OBRIGATÓRIO aqui, não condicional a EMBEDDING_PROVIDER —
    // decisão deliberada, não descuido: o score final que minRelevanceScore
    // compara só faz sentido como um score de relevância tipo 0-1, que é
    // exatamente o que o rerank devolve. O score bruto do RRF (ex.: ~0.03)
    // quebraria esse corte silenciosamente se fosse usado no lugar — por
    // isso, diferente de EMBEDDING_PROVIDER (pluggable: voyage/openai/local),
    // VOYAGE_API_KEY vira um requisito de verdade pra KnowledgeBase
    // funcionar, mesmo que o embedding em uso seja de outro provedor.
    //
    // ACHADO REAL (não teórico) medido neste catálogo de exemplo com
    // rerank-2: pergunta claramente irrelevante ("qual a capital da
    // frança?") rerankou em ~0.25-0.31; a resposta CORRETA pra "vocês
    // entregam em quanto tempo?" rerankou em 0.62; pra "quanto custa o
    // filtro mais barato?", em 0.60. O score de rerank roda numa escala
    // mais baixa que o cosseno puro da versão anterior (onde 0.72 era um
    // corte razoável) — usar 0.72 aqui filtraria FORA as duas respostas
    // corretas acima, voltando "regra de vazio" pra toda pergunta.
    // minRelevanceScore foi recalibrado pra 0.40 (ver config.ts e
    // config/agent.config*.json) — separa bem o irrelevante (~0.3) do
    // relevante (~0.5-0.65) nesse catálogo. Quem já tem um
    // agent.config.json em produção (tenant existente) precisa atualizar
    // esse valor manualmente ao fazer upgrade pra este pipeline — é uma
    // mudança de comportamento, não só de infra.
    if (!env.VOYAGE_API_KEY) {
      throw new Error(
        "KnowledgeBase.search() requires VOYAGE_API_KEY for reranking, independently of EMBEDDING_PROVIDER " +
          "(the final relevance score agentConfig.minRelevanceScore compares against comes from the reranker, " +
          "not from raw RRF/cosine scores)."
      );
    }
    const reranked = await rerank(env.VOYAGE_API_KEY, query, fusedTexts, agentConfig.topK);

    return reranked
      .map(([score, index]) => ({ item: fusedChunks[index].item, score }))
      // "Regra de vazio": descarta qualquer resultado cuja relevância fique
      // abaixo do corte configurado — mesma regra de sempre, agora aplicada
      // ao score do reranker em vez do cosseno puro.
      .filter((chunk) => chunk.score >= agentConfig.minRelevanceScore);
  }
}
