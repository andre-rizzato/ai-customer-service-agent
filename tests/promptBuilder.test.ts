// Testes do montador de system prompt (src/orchestrator/promptBuilder.ts).
// Garante que as 3 regras fixas da Fase 4 do runbook sempre apareçam no
// prompt, que a "regra de vazio" da Fase 3 seja aplicada quando não há
// contexto relevante, e que o prompt nunca mencione um canal específico
// (mantendo-o reutilizável por qualquer ChannelAdapter).
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/orchestrator/promptBuilder.js";
import type { RetrievedChunk } from "../src/types.js";

describe("buildSystemPrompt (Fase 4 — as 3 regras fixas)", () => {
  // Preâmbulo: chama buildSystemPrompt() sem nenhum trecho recuperado
  // (simulando qualquer pergunta) e confirma, via regex, que as três regras
  // fixas do runbook estão todas presentes no texto gerado — se alguém
  // futuramente editar o template e remover uma regra por engano, este
  // teste quebra.
  it("always includes the context-only, transparency, and handoff rules", () => {
    const prompt = buildSystemPrompt([]);
    expect(prompt).toMatch(/Responda SOMENTE com base no trecho de contexto/i);
    expect(prompt).toMatch(/Sou um assistente virtual de/i);
    expect(prompt).toMatch(/Transfira para humano imediatamente/i);
  });

  // Preâmbulo: com uma lista vazia de trechos recuperados (equivalente a
  // "a busca RAG não encontrou nada relevante"), o prompt precisa avisar
  // isso explicitamente ao modelo — é o texto que permite à regra 1 dizer
  // "se a informação não estiver lá, diga isso claramente".
  it("tells the model explicitly when nothing relevant was retrieved (regra de vazio)", () => {
    const prompt = buildSystemPrompt([]);
    expect(prompt).toMatch(/nenhum trecho relevante encontrado/i);
  });

  // Preâmbulo: com um trecho recuperado, confirma que o título e o
  // conteúdo do item aparecem literalmente no prompt, no formato "Título:
  // conteúdo" — é este texto que o LLM usa como única fonte de verdade
  // (regra 1: "responda SOMENTE com base no trecho de contexto").
  it("embeds retrieved chunks verbatim as the grounding context", () => {
    const chunks: RetrievedChunk[] = [
      { item: { id: "x", title: "Filtro FX200", content: "Bivolt, R$ 349,90" }, score: 0.9 },
    ];
    const prompt = buildSystemPrompt(chunks);
    expect(prompt).toContain("Filtro FX200: Bivolt, R$ 349,90");
  });

  // Preâmbulo: garante que o prompt não hardcoda nenhum nome de canal —
  // requisito de design deste projeto (agnóstico de canal), diferente do
  // runbook original que mencionava "WhatsApp" explicitamente no texto.
  it("never hardcodes a channel name (stays generic for Telegram/WhatsApp/web)", () => {
    const prompt = buildSystemPrompt([]);
    expect(prompt.toLowerCase()).not.toContain("whatsapp");
    expect(prompt.toLowerCase()).not.toContain("telegram");
  });
});
