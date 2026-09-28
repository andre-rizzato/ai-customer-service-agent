// Factory de LLMProvider — mesmo padrão da factory de embeddings
// (src/embeddings/index.ts): único lugar que decide, a partir de
// LLM_PROVIDER, qual classe concreta instanciar. O Orchestrator chama
// createLLMProvider() e só conhece a interface LLMProvider.
import { env } from "../config.js";
import { AnthropicProvider } from "./anthropicProvider.js";
import { OpenAIProvider } from "./openaiProvider.js";
import type { LLMProvider } from "./types.js";

// Preâmbulo: createLLMProvider constrói a implementação apropriada de
// LLMProvider para o LLM_PROVIDER configurado no .env, validando a
// presença da respectiva chave de API só neste momento (não em config.ts —
// ver nota de design no final de src/config.ts).
export function createLLMProvider(): LLMProvider {
  switch (env.LLM_PROVIDER) {
    case "anthropic":
      // Falha explicitamente, com mensagem clara, se o provedor escolhido
      // não tiver a chave correspondente configurada — melhor do que deixar
      // o SDK da Anthropic lançar um erro genérico de autenticação depois.
      if (!env.ANTHROPIC_API_KEY) throw new Error("LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY.");
      return new AnthropicProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL);
    case "openai":
      if (!env.OPENAI_API_KEY) throw new Error("LLM_PROVIDER=openai requires OPENAI_API_KEY.");
      return new OpenAIProvider(env.OPENAI_API_KEY, env.OPENAI_MODEL);
  }
}

// Reexporta os tipos usados pelo resto do projeto (Orchestrator importa
// ChatMessage e LLMProvider a partir deste arquivo, não dos arquivos
// individuais dos providers).
export type { ChatMessage, LLMProvider } from "./types.js";
