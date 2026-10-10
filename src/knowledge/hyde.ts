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

// Cache das passagens hipotéticas já geradas (09/10/2026), pra pergunta
// repetida não pagar o LLM de novo. Atendimento repete muito as mesmas
// perguntas ("vocês entregam em quanto tempo?", "tem frete grátis?"), e a
// passagem depende SÓ do texto da pergunta — não da conversa, do cliente
// nem do catálogo (ela é um palpite descartável, ver topo do arquivo) —
// então reaproveitar não muda em nada o resultado da busca.
//
// Map simples em memória, com limite de tamanho: a VM tem 892MB de RAM,
// e 500 passagens de ~1KB são ~0,5MB, irrelevante. Map preserva a ordem
// de inserção, o que dá um LRU barato: ao ler, a entrada é reinserida (vai
// pro fim); ao estourar o limite, sai a primeira (a usada há mais tempo).
// Não persiste em disco de propósito: reiniciar o processo só custa
// alguns HyDEs a mais, e evita mais um arquivo pra gerenciar.
const CACHE_MAX_ENTRIES = 500;
const passageCache = new Map<string, string>();

// Preâmbulo: cacheKey() normaliza a pergunta pra que variações triviais
// ("Tem frete grátis?" / "tem frete gratis ?" / "  tem frete grátis") caiam
// na mesma entrada: minúsculas, sem acento, sem pontuação, espaços
// colapsados. Só a CHAVE é normalizada — o LLM continua recebendo a
// pergunta original na primeira vez.
export function cacheKey(query: string): string {
  return query
    .normalize("NFD")
    // Depois do NFD, "á" vira "a" + acento combinante; esta faixa Unicode
    // são justamente os acentos combinantes, então removê-los tira o acento.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // Tudo que não é letra, número ou espaço (pontuação, emoji) vira espaço.
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Preâmbulo: generateHypotheticalPassage() gera UMA passagem hipotética
// pra pergunta recebida (ou devolve a do cache, ver acima). Devolve texto
// puro — quem chama (knowledgeBase.ts) é responsável por embedar e por
// nunca repassar isso ao cliente.
export async function generateHypotheticalPassage(query: string): Promise<string> {
  const key = cacheKey(query);
  const cached = passageCache.get(key);
  if (cached !== undefined) {
    // Reinsere pra marcar como usada agora (LRU, ver comentário do cache).
    passageCache.delete(key);
    passageCache.set(key, cached);
    return cached;
  }

  const passage = await llmProvider.generate(HYDE_SYSTEM_PROMPT, [{ role: "user", content: query }], {
    temperature: 0.3,
    maxTokens: 200,
    // Etiqueta pro relatório de custo: separa o gasto do HyDE (uma chamada
    // extra de LLM por pergunta) do gasto da resposta ao cliente.
    purpose: "hyde",
  });
  // Passagem vazia (resposta sem bloco de texto) não entra no cache: seria
  // reaproveitar uma falha.
  if (passage) {
    passageCache.set(key, passage);
    if (passageCache.size > CACHE_MAX_ENTRIES) {
      passageCache.delete(passageCache.keys().next().value!);
    }
  }
  return passage;
}
