// Implementação de EmbeddingProvider usando a API HTTP da Voyage AI —
// escolhida como padrão porque a própria Anthropic recomenda a Voyage para
// embeddings (Claude não tem endpoint de embeddings próprio). Não usamos um
// SDK porque a API é um único endpoint REST simples — uma chamada `fetch`
// direta evita mais uma dependência no package.json.
import type { EmbeddingProvider } from "./types.js";

// Endpoint fixo da API de embeddings da Voyage — não muda por modelo (o
// modelo vai no corpo da requisição, não na URL). Desde a aquisição da
// Voyage AI pela MongoDB, chaves emitidas pelo console do Atlas (em vez do
// dashboard standalone da Voyage) só funcionam neste host — o antigo
// api.voyageai.com responde 403 "This API key cannot access this endpoint"
// para esse tipo de chave.
const VOYAGE_API_URL = "https://ai.mongodb.com/v1/embeddings";

// Preâmbulo: VoyageEmbeddings implementa EmbeddingProvider chamando a API
// da Voyage AI. É instanciada por src/embeddings/index.ts quando
// EMBEDDING_PROVIDER=voyage (o padrão). Guarda a chave de API, o modelo e o
// "input_type" (documento vs. pergunta) recebidos no construtor para não
// precisar repeti-los em cada chamada de embed().
export class VoyageEmbeddings implements EmbeddingProvider {
  constructor(
    // Chave de API (VOYAGE_API_KEY do .env), enviada no header Authorization.
    private readonly apiKey: string,
    // Nome do modelo Voyage a usar (ex.: "voyage-3.5-lite"), vem de
    // VOYAGE_MODEL no .env.
    private readonly model: string,
    // Voyage otimiza o vetor de forma diferente dependendo se o texto é um
    // "documento" (conteúdo da base, indexado uma vez no ingest) ou uma
    // "query" (pergunta do usuário, embutida a cada mensagem) — por isso o
    // factory em embeddings/index.ts cria duas instâncias diferentes desta
    // classe, uma para cada input_type.
    private readonly inputType: "document" | "query" = "document"
  ) {}

  // Preâmbulo: embed() é o método exigido pela interface EmbeddingProvider.
  // Chamado por src/knowledge/ingest.ts (uma vez por item do catálogo, em
  // lote) e por src/knowledge/knowledgeBase.ts (uma vez por pergunta do
  // usuário, com uma lista de um único texto).
  async embed(texts: string[]): Promise<number[][]> {
    // Evita uma chamada de rede desnecessária se a lista de entrada estiver
    // vazia — a API da Voyage provavelmente aceitaria, mas não há por que
    // pagar a latência de uma requisição HTTP para não retornar nada.
    if (texts.length === 0) return [];

    // Faz a chamada HTTP POST para a API da Voyage. `fetch` é global no
    // Node 18+, então não precisa de import extra.
    const res = await fetch(VOYAGE_API_URL, {
      method: "POST",
      headers: {
        // Corpo é JSON.
        "Content-Type": "application/json",
        // Autenticação Bearer, exigida pela API da Voyage.
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        // A API aceita um array de textos e embeda todos em uma única
        // chamada — por isso ingest.ts manda o catálogo inteiro de uma vez
        // em vez de item por item, reduzindo número de requisições.
        input: texts,
        model: this.model,
        input_type: this.inputType,
      }),
    });

    // fetch só rejeita a Promise em falha de rede; um erro HTTP (4xx/5xx)
    // ainda chega aqui como res.ok === false, então checamos manualmente.
    if (!res.ok) {
      // Lê o corpo da resposta de erro como texto para incluir na mensagem
      // de exceção (ajuda a depurar problemas de chave inválida, modelo
      // errado etc.); .catch(() => "") evita que uma falha ao LER o corpo
      // mascare o erro HTTP original.
      const body = await res.text().catch(() => "");
      throw new Error(`Voyage embeddings request failed (${res.status}): ${body}`);
    }

    // A resposta da Voyage vem como { data: [{ embedding, index }, ...] },
    // e não há garantia de que `data` volte na mesma ordem da entrada —
    // por isso ordenamos explicitamente por `index` antes de extrair só os
    // vetores, preservando o contrato de EmbeddingProvider.embed (mesma
    // ordem da entrada).
    const data = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    return [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
