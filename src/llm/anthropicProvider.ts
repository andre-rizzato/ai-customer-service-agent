// Implementação de LLMProvider usando a API da Anthropic (Claude) via SDK
// oficial @anthropic-ai/sdk. É o provedor padrão do projeto
// (LLM_PROVIDER=anthropic).
import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, LLMProvider } from "./types.js";

// Preâmbulo: AnthropicProvider implementa LLMProvider chamando o endpoint
// de Messages da Anthropic. Instanciada por src/llm/index.ts quando
// LLM_PROVIDER=anthropic (o padrão).
export class AnthropicProvider implements LLMProvider {
  // Cliente do SDK, criado uma vez no construtor e reaproveitado em todas
  // as chamadas de generate().
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model: string) {
    this.client = new Anthropic({ apiKey });
  }

  // Preâmbulo: generate() monta e envia a chamada para
  // client.messages.create — o endpoint de chat da Anthropic — e extrai o
  // texto da resposta. Chamado uma vez por mensagem do usuário, pelo
  // Orchestrator (src/orchestrator/orchestrator.ts), depois que o
  // system prompt e o histórico já foram montados.
  async generate(systemPrompt: string, history: ChatMessage[]): Promise<string> {
    const res = await this.client.messages.create({
      model: this.model,
      // A API da Anthropic exige um limite máximo de tokens de saída
      // explícito; 1024 é generoso o bastante para respostas de
      // atendimento (curtas) sem permitir respostas descontroladamente
      // longas (o que também protege contra custo).
      max_tokens: 1024,
      // Diferente da OpenAI, a Anthropic recebe o "system prompt" como um
      // parâmetro próprio (`system`), separado do array `messages` — é por
      // isso que LLMProvider.generate recebe systemPrompt e history como
      // argumentos distintos em vez de um único array com role "system".
      system: systemPrompt,
      // Remapeia ChatMessage[] para o formato exato esperado pelo SDK —
      // hoje os dois formatos já são idênticos, mas o `.map` explícito
      // documenta a conversão e isola o resto do código de uma eventual
      // mudança no formato interno de ChatMessage.
      messages: history.map((m) => ({ role: m.role, content: m.content })),
    });
    // A resposta da Anthropic vem como uma lista de "blocos de conteúdo"
    // (texto, uso de ferramenta, etc.) porque a API suporta multi-modalidade
    // e tool use; como este agente só pede texto, procuramos o primeiro
    // bloco do tipo "text" e ignoramos qualquer outro tipo de bloco.
    const textBlock = res.content.find((b) => b.type === "text");
    // Se por algum motivo não vier nenhum bloco de texto (ex.: resposta
    // vazia), devolve string vazia em vez de deixar `undefined` vazar para
    // quem chama — o Orchestrator sempre espera uma string de volta.
    return textBlock?.type === "text" ? textBlock.text : "";
  }
}
