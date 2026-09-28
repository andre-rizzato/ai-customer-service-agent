// Monta o system prompt enviado ao LLM a cada mensagem — a Fase 4 do
// runbook chama isso de "o contrato de comportamento". As três regras fixas
// abaixo são mantidas propositalmente em espírito idêntico ao texto
// original do runbook (Fase 4), e o prompt é escrito de forma
// deliberadamente agnóstica de canal (nenhuma menção a WhatsApp/Telegram) —
// assim o mesmo prompt funciona sem alteração por trás de qualquer
// ChannelAdapter.
import { agentConfig } from "../config.js";
import type { RetrievedChunk } from "../types.js";

// Preâmbulo: buildSystemPrompt() recebe os trechos já recuperados e
// filtrados pela KnowledgeBase (ver knowledgeBase.ts — já passaram pelo
// corte de relevância mínima) e devolve a string completa de system prompt.
// Chamada pelo Orchestrator uma vez por mensagem, depois de confirmar que
// não houve gatilho de handoff.
export function buildSystemPrompt(retrieved: RetrievedChunk[]): string {
  // Monta o bloco de "contexto recuperado da base": se houver trechos
  // relevantes, lista cada um como "- Título: conteúdo"; se a busca não
  // encontrou nada acima do corte de relevância (regra de vazio da Fase 3),
  // escreve uma frase explícita dizendo isso — é essa frase explícita que
  // permite à regra fixa nº 1 abaixo instruir o modelo a admitir que não
  // sabe, em vez de o modelo receber um bloco de contexto vazio/ambíguo e
  // tentar preencher a lacuna sozinho.
  const context =
    retrieved.length > 0
      ? retrieved.map((c) => `- ${c.item.title}: ${c.item.content}`).join("\n")
      : "(nenhum trecho relevante encontrado na base de conhecimento para esta pergunta)";

  // Template literal com o prompt completo. `agentConfig.businessName` e
  // `agentConfig.toneAdjectives` vêm de config/agent.config.json (Fase 0:
  // definidos por negócio, antes de qualquer linha de código); `context` é
  // o bloco montado acima.
  return `Você é o assistente virtual de ${agentConfig.businessName}.

REGRAS FIXAS (nunca quebrar):
1. Responda SOMENTE com base no trecho de contexto fornecido abaixo.
   Se a informação não estiver lá, diga isso claramente e ofereça
   transferir para um atendente humano. Nunca invente specs, preços
   ou prazos.
2. Se perguntarem se você é humano ou IA, responda com transparência
   total: "Sou um assistente virtual de ${agentConfig.businessName}."
3. Transfira para humano imediatamente se: (a) o cliente pedir
   explicitamente, (b) a pergunta sair do escopo de produto/venda,
   (c) houver sinal de reclamação ou frustração.

TOM: ${agentConfig.toneAdjectives.join(", ")}

CONTEXTO RECUPERADO DA BASE:
${context}

Responda à última mensagem do cliente.`;
  // Nota: a regra 3 acima é reforçada (não substituída) pelo detector de
  // handoff em handoff.ts, que roda ANTES desta função ser chamada — a
  // regra escrita no prompt é uma segunda camada de segurança para os casos
  // que o detector por palavra-chave não pegar (ex.: frustração implícita
  // sem usar nenhuma das palavras da lista configurada).
}
