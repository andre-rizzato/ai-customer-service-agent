// Implementação alternativa de LLMProvider usando a API de Chat Completions
// da OpenAI (ex.: gpt-4o-mini) — opção mencionada no runbook original como
// alternativa ao Claude Haiku, mantida como provedor plugável
// (LLM_PROVIDER=openai).
import OpenAI from "openai";
import type { ChatMessage, LLMProvider } from "./types.js";

// Preâmbulo: OpenAIProvider implementa LLMProvider chamando
// chat.completions.create via SDK oficial. Instanciada por
// src/llm/index.ts quando LLM_PROVIDER=openai.
export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;

  constructor(apiKey: string, private readonly model: string) {
    this.client = new OpenAI({ apiKey });
  }

  // Preâmbulo: generate() cumpre o mesmo contrato de
  // AnthropicProvider.generate, mas usando o formato da API da OpenAI, que
  // — diferente da Anthropic — trata o "system prompt" como só mais uma
  // mensagem no mesmo array, com role "system".
  async generate(systemPrompt: string, history: ChatMessage[]): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      // Monta um único array: primeiro a mensagem de sistema (regras +
      // contexto do RAG), depois o histórico da conversa na ordem em que
      // aconteceu — é assim que a API de Chat Completions espera receber o
      // prompt inteiro.
      messages: [{ role: "system", content: systemPrompt }, ...history],
    });
    // A resposta vem em `choices` (a API suporta pedir múltiplas
    // completions alternativas); como não pedimos mais de uma, usamos
    // sempre a primeira. `?? ""` cobre o caso (raro) de a API devolver uma
    // choice sem conteúdo de mensagem.
    return res.choices[0]?.message?.content ?? "";
  }
}
