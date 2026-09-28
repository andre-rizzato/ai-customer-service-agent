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

export interface LLMProvider {
  // Gera a próxima resposta do assistente. `systemPrompt` carrega as regras
  // fixas + contexto do RAG (ver promptBuilder.ts); `history` é a conversa
  // até aqui (sem o system prompt, que é passado à parte porque cada API
  // trata "system" de forma distinta do histórico user/assistant).
  generate(systemPrompt: string, history: ChatMessage[]): Promise<string>;
}
