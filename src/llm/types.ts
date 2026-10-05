// Contrato comum para "gerar uma resposta de chat a partir de um prompt de
// sistema e um histórico" — o Orchestrator depende só desta interface, o
// que permite trocar Claude por GPT (ou adicionar um terceiro provedor) sem
// tocar em nenhuma linha do pipeline principal.

// Formato de UMA mensagem dentro do histórico enviado ao modelo — mesmo
// shape que tanto a API da Anthropic quanto a da OpenAI esperam (role +
// content), o que simplifica a implementação de ambos os providers.
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// Parâmetros de geração configuráveis pelo negócio (ver tela
// public/settings.html e agentConfig.temperature/maxTokens em
// src/config.ts) — por isso ficam num objeto à parte, passado pelo
// Orchestrator a cada chamada, em vez de fixados no construtor do provider
// como antes: um valor lido no construtor não mudaria se o negócio salvasse
// uma nova temperatura pela tela sem reiniciar o processo.
export interface GenerateOptions {
  temperature: number;
  maxTokens: number;
}

export interface LLMProvider {
  // Gera a próxima resposta do assistente. `systemPrompt` carrega as regras
  // fixas + contexto do RAG (ver promptBuilder.ts); `history` é a conversa
  // até aqui (sem o system prompt, que é passado à parte porque cada API
  // trata "system" de forma distinta do histórico user/assistant).
  generate(systemPrompt: string, history: ChatMessage[], options: GenerateOptions): Promise<string>;
}
