// Testes do detector de gatilho de handoff (src/orchestrator/handoff.ts).
// Cobre a parte da matriz de testes da Fase 5 do runbook que é
// determinística e não depende de chamar nenhuma API externa: "pedido
// explícito de humano" e "mensagem de reclamação/frustração" (os outros
// itens da matriz — dentro do escopo, fora do escopo, "você é IA?" —
// dependem do LLM responder e são testados manualmente via
// `npm run simulate`, não aqui).
import { describe, expect, it } from "vitest";
import { detectHandoffTrigger } from "../src/orchestrator/handoff.js";

// describe() agrupa os testes relacionados sob um rótulo comum, exibido no
// relatório do vitest — não afeta a execução, só a organização/leitura do
// resultado.
describe("detectHandoffTrigger (Fase 5 matrix)", () => {
  // Preâmbulo: confirma que uma frase contendo uma das handoffKeywords
  // configuradas em config/agent.config.example.json (ex.: "falar com
  // atendente") é classificada como "explicit_request", o motivo de maior
  // prioridade no detector.
  it("detects an explicit human request", () => {
    expect(detectHandoffTrigger("quero falar com atendente por favor")).toBe("explicit_request");
  });

  // Preâmbulo: confirma que uma frase contendo uma das frustrationKeywords
  // (ex.: "péssimo", "não aguento") é classificada como "frustration".
  it("detects frustration keywords", () => {
    expect(detectHandoffTrigger("isso é um serviço péssimo, não aguento mais")).toBe("frustration");
  });

  // Preâmbulo: confirma o comportamento de normalize() dentro de
  // handoff.ts — a comparação deve ignorar maiúsculas/minúsculas e acentos,
  // então "QUERO FALAR COM ATENDENTE" e "horrivel" (sem acento) também
  // precisam disparar.
  it("is case-insensitive and accent-insensitive", () => {
    expect(detectHandoffTrigger("QUERO FALAR COM ATENDENTE")).toBe("explicit_request");
    expect(detectHandoffTrigger("que serviço horrivel")).toBe("frustration");
  });

  // Preâmbulo: uma pergunta normal sobre produto não deve disparar nenhum
  // gatilho — o pipeline deve seguir para a busca RAG normalmente.
  it("returns null for an in-scope product question", () => {
    expect(detectHandoffTrigger("qual a voltagem do filtro FX200?")).toBeNull();
  });

  // Preâmbulo: uma mensagem ambígua/informal, sem nenhuma palavra-chave
  // configurada, também não deve disparar nada — garante que o detector não
  // seja "gatilho fácil demais" e comece a interromper conversas normais.
  it("returns null for an ambiguous message", () => {
    expect(detectHandoffTrigger("oi bom dia gostaria de saber sobre o produto blz")).toBeNull();
  });
});
