// Factory (fábrica) de EmbeddingProvider: é o ÚNICO lugar do projeto que
// decide, a partir da variável de ambiente EMBEDDING_PROVIDER, qual
// implementação concreta instanciar. Todo o resto do código (ingest.ts,
// knowledgeBase.ts) chama createEmbeddingProvider() e programa contra a
// interface EmbeddingProvider — nunca importa VoyageEmbeddings,
// OpenAIEmbeddings ou LocalEmbeddings diretamente.
import { env } from "../config.js";
import { VoyageEmbeddings } from "./voyageEmbeddings.js";
import { OpenAIEmbeddings } from "./openaiEmbeddings.js";
import { LocalEmbeddings } from "./localEmbeddings.js";
import type { EmbeddingProvider } from "./types.js";

// Preâmbulo: createEmbeddingProvider constrói a implementação de
// EmbeddingProvider apropriada para o EMBEDDING_PROVIDER configurado.
// Recebe `inputType` porque a Voyage distingue embeddings de "documento"
// (usados na indexação do catálogo) de embeddings de "query" (usados a cada
// pergunta do usuário) — os outros provedores ignoram esse parâmetro, mas
// ele fica na assinatura comum para não vazar essa particularidade da
// Voyage para quem chama a factory.
export function createEmbeddingProvider(inputType: "document" | "query" = "document"): EmbeddingProvider {
  // switch sobre um union type validado pelo zod em config.ts — o
  // TypeScript garante exaustividade aqui (se um novo valor for adicionado
  // ao enum sem um `case` correspondente, o compilador acusa erro).
  switch (env.EMBEDDING_PROVIDER) {
    case "voyage":
      // Validação da credencial adiada para este ponto (e não em
      // config.ts) — só falha se alguém realmente tentar usar Voyage sem
      // configurar a chave, não apenas por importar o módulo de config.
      if (!env.VOYAGE_API_KEY) throw new Error("EMBEDDING_PROVIDER=voyage requires VOYAGE_API_KEY.");
      return new VoyageEmbeddings(env.VOYAGE_API_KEY, env.VOYAGE_MODEL, inputType);
    case "openai":
      if (!env.OPENAI_API_KEY) throw new Error("EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY.");
      return new OpenAIEmbeddings(env.OPENAI_API_KEY, env.OPENAI_EMBEDDING_MODEL);
    case "local":
      // Não exige nenhuma credencial — roda localmente.
      return new LocalEmbeddings();
  }
}

// Reexporta o tipo da interface para que outros módulos possam importar
// tanto a factory quanto o tipo a partir deste único arquivo
// ("src/embeddings/index.ts" como fachada do pacote de embeddings).
export type { EmbeddingProvider } from "./types.js";
