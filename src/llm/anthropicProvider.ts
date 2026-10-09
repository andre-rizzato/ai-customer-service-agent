// Implementação de LLMProvider usando a API da Anthropic (Claude) via SDK
// oficial @anthropic-ai/sdk. É o provedor padrão do projeto
// (LLM_PROVIDER=anthropic).
import Anthropic from "@anthropic-ai/sdk";
import { recordUsage } from "../usage/usageMeter.js";
import type { ChatMessage, GenerateOptions, LLMProvider } from "./types.js";

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
  async generate(systemPrompt: string, history: ChatMessage[], options: GenerateOptions): Promise<string> {
    const res = await this.client.messages.create({
      model: this.model,
      // A API da Anthropic exige um limite máximo de tokens de saída
      // explícito — vem de agentConfig.maxTokens (configurável pela tela de
      // configuração), não mais um valor fixo no código.
      max_tokens: options.maxTokens,
      // Controla aleatoriedade da resposta (0 = mais determinística, 1 =
      // mais variada) — vem de agentConfig.temperature.
      temperature: options.temperature,
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
    // Registra o consumo desta chamada pro relatório de custo por cliente
    // (ver src/usage/usageMeter.ts). res.usage vem em toda resposta da API
    // — é o número que a Anthropic de fato cobra, não uma estimativa.
    // res.model (e não this.model) porque é o modelo que realmente atendeu.
    // Os dois campos de cache vêm da API, mas o SDK instalado
    // (@anthropic-ai/sdk 0.32) ainda não os declara no tipo Usage — por isso
    // a leitura via um tipo local, em vez de subir a versão do SDK só por
    // isso. Podem vir null/ausentes quando caching não é usado; `?? 0`
    // normaliza pra número.
    const cacheUsage = res.usage as { cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
    recordUsage({
      kind: "llm",
      provider: "anthropic",
      model: res.model,
      purpose: options.purpose,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: cacheUsage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: cacheUsage.cache_creation_input_tokens ?? 0,
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
