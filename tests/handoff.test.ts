// Testes do detector de gatilho de handoff (src/orchestrator/handoff.ts).
// Cobre a parte da matriz de testes da Fase 5 do runbook que é
// determinística e não depende de chamar nenhuma API externa: "pedido
// explícito de humano" e "mensagem de reclamação/frustração" (os outros
// itens da matriz — dentro do escopo, fora do escopo, "você é IA?" —
// dependem do LLM responder e são testados manualmente via
// `npm run simulate`, não aqui).
import { describe, expect, it } from "vitest";
import { HANDOFF_SIGNAL, detectAssistantHandoff, detectHandoffTrigger } from "../src/orchestrator/handoff.js";

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

// Testes de detectAssistantHandoff() (06/10/2026): o LLM decidindo
// transferir. As frases "claim" são as respostas REAIS do bug reportado — o
// cliente aceitou a oferta e o modelo prometeu transferir sem que nada
// acontecesse.
describe("detectAssistantHandoff (LLM decidindo transferir)", () => {
  // Preâmbulo: o caminho certo — o modelo usa o sinal combinado no prompt.
  it("reconhece o sinal combinado", () => {
    expect(detectAssistantHandoff(HANDOFF_SIGNAL)).toBe("signal");
    expect(detectAssistantHandoff(`Claro! ${HANDOFF_SIGNAL}`)).toBe("signal");
  });

  // Preâmbulo: rede de segurança com as frases exatas que o bot de
  // produção respondeu em 06/10 sem transferir nada.
  it("pega a promessa de transferência sem o sinal (frases reais do bug)", () => {
    expect(detectAssistantHandoff("Perfeito! Vou transferi-lo para um atendente humano agora.")).toBe("claim");
    expect(detectAssistantHandoff("Perfeito! 🤝\n\nEstou transferindo você para um atendente humano agora.")).toBe("claim");
    expect(detectAssistantHandoff("Vou te conectar com alguém da equipe.")).toBe("claim");
  });

  // Preâmbulo: OFERECER não é transferir — essas não podem disparar, senão
  // o bot ficaria mudo sem o cliente ter aceitado.
  it("não confunde oferta com transferência", () => {
    expect(detectAssistantHandoff("Posso transferir você para um atendente humano. Deseja?")).toBeNull();
    expect(detectAssistantHandoff("Quer que eu te transfira para um atendente?")).toBeNull();
    expect(detectAssistantHandoff("Nosso horário de atendimento é das 9h às 18h.")).toBeNull();
  });
});
