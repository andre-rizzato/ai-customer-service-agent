// Contrato comum para "converter texto em vetor numérico" (embedding).
// Existe como interface separada para que o resto do código (ingest.ts,
// knowledgeBase.ts) dependa só desta forma abstrata, nunca de um provedor
// específico — trocar Voyage por OpenAI ou por um modelo local vira só
// trocar qual classe é instanciada em embeddings/index.ts.
export interface EmbeddingProvider {
  // Recebe uma lista de textos e devolve uma lista de vetores (arrays de
  // números), NA MESMA ORDEM da entrada — quem chama depende dessa garantia
  // de ordem para associar cada vetor de volta ao seu texto/item de origem.
  embed(texts: string[]): Promise<number[][]>;
}
