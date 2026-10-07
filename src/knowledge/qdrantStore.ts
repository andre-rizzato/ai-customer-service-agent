// Armazenamento vetorial em Qdrant — substitui o FileVectorStore (cosseno
// "na unha" sobre um arquivo JSON). O comentário original daquele arquivo já
// previa este exato ponto de troca: "deixar explícito qual seria o ponto de
// troca caso o catálogo cresça demais para uma busca linear (Pinecone,
// pgvector, Supabase...)". Mesma técnica do AgentService irmão
// (DistributedOrderSystem/src/AgentService/rag/qdrant_client.py) — essa
// classe é a porta TypeScript daquele arquivo Python, adaptada pro
// catálogo genérico deste projeto (sem os filtros estruturados por
// customer_phone/order_status que o AgentService precisa, porque aqui não
// há dado privado por cliente — é um catálogo público de produto/serviço).
import { QdrantClient } from "@qdrant/js-client-rest";
import { env } from "../config.js";
import type { KnowledgeItem, RetrievedChunk } from "../types.js";

// Nome fixo da única coleção deste projeto — diferente do AgentService
// irmão (que tem 2 coleções, uma por domínio de dado), este catálogo é
// genérico o bastante pra não precisar split nenhum.
const COLLECTION_NAME = "catalog";

// Preâmbulo: construído uma vez por processo, não por request — mesmo
// motivo do client Python (QdrantClient mantém seu próprio pool de conexão
// HTTP internamente).
//
// port: null é OBRIGATÓRIO aqui, não cosmético: inspecionando o código-fonte
// do @qdrant/js-client-rest (qdrant-client.js, linha ~28), o parâmetro
// `port` tem default 6333 e é usado SEMPRE que a `url` passada não tem uma
// porta explícita na própria string — exatamente o que acontece com a URL
// hospedada no Azure Container Apps (só HTTPS na porta 443 padrão, sem
// porta na string). Sem port: null, toda chamada contra a instância de
// produção tentaria host:6333 (não exposto externamente) e travaria em
// timeout — mesmo bug encontrado (e corrigido) no cliente Python irmão.
const client = new QdrantClient({
  url: env.QDRANT_URL,
  apiKey: env.QDRANT_API_KEY,
  port: null,
});

// Formato de UM ponto guardado no Qdrant: o item original inteiro vai no
// payload (não só o id) — mesma decisão do FileVectorStore antigo, pelo
// mesmo motivo: a busca não precisa recarregar o catálogo original, o
// vector store é autossuficiente.
interface QdrantPayload {
  item: KnowledgeItem;
}

// Preâmbulo: garante que a coleção existe, criando-a (com a dimensão certa
// do modelo de embedding em uso) se ainda não existir. Idempotente — chamada
// toda vez que o ingest roda, sem precisar checar estado antes. A dimensão
// não é um número fixo no código: é descoberta embedando um texto de
// verdade (mesmo princípio do curso: nunca adivinhar o tamanho de um
// modelo, verificar).
export async function ensureCollection(vectorSize: number): Promise<void> {
  const exists = await client.collectionExists(COLLECTION_NAME);
  if (exists.exists) return;
  await client.createCollection(COLLECTION_NAME, {
    vectors: { size: vectorSize, distance: "Cosine" },
  });
}

// Preâmbulo: replaceAll() descarta o índice inteiro e grava os pares
// (item, vetor) recebidos — mesmo contrato do FileVectorStore.replaceAll()
// que este arquivo substitui, chamado por ingest.ts a cada reindexação
// completa do catálogo.
export async function replaceAll(records: { item: KnowledgeItem; vector: number[] }[]): Promise<void> {
  // Upsert em vez de "limpar e inserir": como o catálogo é pequeno e os ids
  // são estáveis (vêm de KnowledgeItem.id), sobrescrever os pontos existentes
  // e deixar pontos órfãos de uma versão anterior do catálogo é um risco
  // aceitável para o tamanho atual do projeto — se isso vier a importar,
  // trocar por um delete_collection + create explícito antes do upsert.
  await client.upsert(COLLECTION_NAME, {
    wait: true,
    points: records.map((r, i) => ({
      id: i,
      vector: r.vector,
      payload: { item: r.item } satisfies QdrantPayload,
    })),
  });
}

// Preâmbulo: query() busca por similaridade vetorial pura — SEM filtro de
// payload, porque este catálogo não tem dado privado por cliente (diferente
// do AgentService irmão). A busca híbrida/rerank (knowledgeBase.ts) chama
// isto como UMA das entradas do pipeline, não como a busca final.
export async function query(vector: number[], topK: number): Promise<RetrievedChunk[]> {
  const result = await client.query(COLLECTION_NAME, {
    query: vector,
    limit: topK,
    with_payload: true,
  });
  return result.points.map((point) => ({
    item: (point.payload as unknown as QdrantPayload).item,
    score: point.score,
  }));
}
