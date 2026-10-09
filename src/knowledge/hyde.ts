// HyDE (Hypothetical Document Embeddings) — porta TypeScript de
// CursoClaude/ai/week13/hyde.py e do mesmo mecanismo do AgentService irmão
// (rag/hyde.py). Em vez de embedar a pergunta crua do cliente, pede ao LLM
// uma passagem HIPOTÉTICA no mesmo registro do catálogo real (ficha de
// produto/política, não pergunta), e embeda essa passagem no lugar.
//
// Por que isso ajuda: um bi-encoder (embeddings/*.ts) compara dois vetores
// que nunca foram computados juntos — uma pergunta casual do cliente
// ("quanto custa o filtro?") e uma ficha técnica formal ("Filtro de água
// FX200... Preço: R$ 349,90...") podem ser sobre a mesma coisa e ainda
// assim ficarem longe no espaço de embedding, porque são ATOS DE FALA
// diferentes (pergunta vs. afirmação), não só vocabulário diferente. A
// passagem hipotética é declarativa, no mesmo registro do catálogo real —
// por isso o embedding dela tende a cair mais perto do item certo, mesmo
// que a passagem hipotética erre o fato específico (ela é descartada
// imediatamente depois de embedada — ver knowledgeBase.ts — NUNCA mostrada
// ao cliente nem tratada como fato).
import { createLLMProvider } from "../llm/index.js";

// Reusa a MESMA abstração pluggable que o resto do projeto já usa pra
// responder o cliente (Claude ou GPT, via LLM_PROVIDER) — HyDE não precisa
// de nenhuma credencial/cliente novo além do que já existe.
const llmProvider = createLLMProvider();

const HYDE_SYSTEM_PROMPT = `Você escreve trechos curtos e formais de catálogo de produto/serviço ou política de uma loja, no estilo de uma ficha técnica interna (termos como "especificações", "prazo", "garantia", "elegibilidade"). Não se preocupe se os fatos específicos estão corretos — o que importa é o REGISTRO formal do texto, como se fosse um trecho real do catálogo. Responda só com o trecho, sem introdução.`;

// Preâmbulo: generateHypotheticalPassage() gera UMA passagem hipotética
// pra pergunta recebida. Devolve texto puro — quem chama (knowledgeBase.ts)
// é responsável por embedar e por nunca repassar isso ao cliente.
export async function generateHypotheticalPassage(query: string): Promise<string> {
  return llmProvider.generate(HYDE_SYSTEM_PROMPT, [{ role: "user", content: query }], {
    temperature: 0.3,
    maxTokens: 200,
    // Etiqueta pro relatório de custo: separa o gasto do HyDE (uma chamada
    // extra de LLM por pergunta) do gasto da resposta ao cliente.
    purpose: "hyde",
  });
}
