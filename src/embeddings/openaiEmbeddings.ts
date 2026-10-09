// Implementação alternativa de EmbeddingProvider usando a API de embeddings
// da OpenAI — útil para quem já paga OpenAI e não quer abrir mais uma conta
// (Voyage), ou para comparar qualidade dos dois provedores no mesmo projeto.
// Diferente da VoyageEmbeddings, aqui usamos o SDK oficial `openai` (já é
// dependência do projeto por causa do OpenAIProvider de LLM em src/llm/).
import OpenAI from "openai";
import { recordUsage } from "../usage/usageMeter.js";
import type { EmbeddingProvider } from "./types.js";

// Preâmbulo: OpenAIEmbeddings implementa EmbeddingProvider chamando a API
// de embeddings da OpenAI via SDK oficial. Instanciada por
// src/embeddings/index.ts quando EMBEDDING_PROVIDER=openai.
export class OpenAIEmbeddings implements EmbeddingProvider {
  // Cliente do SDK, configurado uma vez no construtor e reaproveitado em
  // toda chamada de embed() (evita recriar a conexão HTTP a cada mensagem).
  private readonly client: OpenAI;

  constructor(apiKey: string, private readonly model: string) {
    // O SDK da OpenAI recebe a chave de API diretamente no construtor —
    // não há necessidade de configurar headers manualmente como fizemos com
    // fetch na VoyageEmbeddings.
    this.client = new OpenAI({ apiKey });
  }

  // Preâmbulo: embed() cumpre o mesmo contrato de VoyageEmbeddings.embed —
  // texto(s) de entrada, vetor(es) de saída na mesma ordem. Chamada pelos
  // mesmos dois lugares: ingest.ts (lote, na indexação) e knowledgeBase.ts
  // (pergunta única, por mensagem).
  async embed(texts: string[]): Promise<number[][]> {
    // Mesmo guard-clause da VoyageEmbeddings: evita chamada de API à toa.
    if (texts.length === 0) return [];
    // O SDK aceita um array em `input` e devolve um item de `data` por
    // texto de entrada, já na ordem correta — diferente da API HTTP crua da
    // Voyage, aqui não precisamos reordenar manualmente.
    const res = await this.client.embeddings.create({ model: this.model, input: texts });
    // Registra o consumo (ver src/usage/usageMeter.ts). Diferente da
    // Voyage, esta classe não sabe se está embedando pergunta ou catálogo
    // (a OpenAI não distingue input_type), então não marca `purpose` — o
    // relatório separa os dois pelo conversationId (indexação roda fora de
    // qualquer conversa).
    recordUsage({ kind: "embedding", provider: "openai", model: this.model, inputTokens: res.usage.total_tokens });
    // Extrai só o vetor de cada item da resposta, descartando os metadados
    // restantes (índice) que o pipeline não usa.
    return res.data.map((d) => d.embedding);
  }
}
