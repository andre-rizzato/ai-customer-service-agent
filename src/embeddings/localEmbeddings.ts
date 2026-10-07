// Implementação de EmbeddingProvider que roda 100% localmente, sem chamar
// nenhuma API externa e sem precisar de nenhuma chave — útil para
// desenvolvimento offline, testes, ou para quem não quer depender de um
// provedor pago só para gerar embeddings de um catálogo pequeno.
import type { EmbeddingProvider } from "./types.js";

// Preâmbulo: LocalEmbeddings carrega um modelo pequeno de sentence
// embeddings (all-MiniLM-L6-v2, ~80MB) via @xenova/transformers, que roda
// em WebAssembly dentro do próprio processo Node — a primeira execução
// baixa os pesos do modelo e os guarda em cache local (node_modules/@xenova
// ou pasta de cache do sistema); execuções seguintes reaproveitam o cache.
export class LocalEmbeddings implements EmbeddingProvider {
  // Guarda a Promise de inicialização do pipeline (não o pipeline em si)
  // para garantir que o modelo seja carregado NO MÁXIMO uma vez por processo,
  // mesmo que embed() seja chamado várias vezes em paralelo antes da
  // primeira carga terminar — todas as chamadas concorrentes esperam a
  // mesma Promise em vez de disparar downloads/carregamentos duplicados.
  private pipelinePromise: Promise<any> | null = null;

  // Preâmbulo: getPipeline() devolve (e, na primeira vez, cria) o pipeline
  // de extração de features do @xenova/transformers. É privado — só embed()
  // chama este método.
  private async getPipeline() {
    // Só inicializa se ainda não houver uma Promise em andamento/concluída.
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        // Import dinâmico (não `import` estático no topo do arquivo) para
        // que o custo de carregar essa biblioteca (e o download do modelo)
        // só aconteça se LocalEmbeddings for realmente usado — projetos
        // configurados para Voyage/OpenAI nunca pagam esse custo, mesmo que
        // @xenova/transformers esteja instalado como optionalDependency.
        const { pipeline } = await import("@xenova/transformers");
        // "feature-extraction" é a task do transformers.js para produzir
        // embeddings de sentença a partir de um modelo tipo BERT.
        return pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
      })();
    }
    return this.pipelinePromise;
  }

  // Preâmbulo: embed() cumpre o mesmo contrato das outras implementações,
  // mas processa um texto de cada vez em vez de em lote, porque a API do
  // transformers.js não expõe batching trivial para este pipeline — para o
  // volume de um catálogo pequeno (dezenas de itens) isso é aceitável.
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Garante que o modelo esteja carregado antes do loop abaixo.
    const extractor = await this.getPipeline();
    const vectors: number[][] = [];
    // Processa cada texto sequencialmente...
    for (const text of texts) {
      // pooling: "mean" combina os embeddings de cada token do texto em um
      // único vetor de sentença (em vez de devolver um vetor por token);
      // normalize: true escala o vetor para norma 1, necessário para que a
      // distância de cosseno usada no Qdrant (ver qdrantStore.ts) funcione
      // de forma comparável com os vetores vindos de Voyage/OpenAI (que já
      // vêm normalizados).
      const output = await extractor(text, { pooling: "mean", normalize: true });
      // A saída do transformers.js é um tensor com um Float32Array de dados
      // — convertemos para number[] comum para bater com o tipo esperado
      // por EmbeddingProvider e para poder ser serializado em JSON na
      // chamada REST pro Qdrant.
      vectors.push(Array.from(output.data as Float32Array));
    }
    return vectors;
  }
}
