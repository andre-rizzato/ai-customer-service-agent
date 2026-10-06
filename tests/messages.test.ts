// Testes do suporte a idioma (06/10/2026): bug real — as versões em inglês e
// italiano do site recebiam respostas em português. Cobre a normalização do
// código de idioma que os canais mandam, as mensagens fixas traduzidas e a
// instrução de idioma no system prompt.
import { describe, expect, it } from "vitest";
import { message, normalizeLanguage } from "../src/orchestrator/messages.js";
import { buildSystemPrompt } from "../src/orchestrator/promptBuilder.js";

describe("normalizeLanguage", () => {
  // Preâmbulo: navegadores e Telegram mandam códigos completos; só o
  // prefixo importa.
  it("aceita códigos completos e variações de caixa", () => {
    expect(normalizeLanguage("pt-BR")).toBe("pt");
    expect(normalizeLanguage("en-US")).toBe("en");
    expect(normalizeLanguage("IT")).toBe("it");
    expect(normalizeLanguage("it_IT")).toBe("it");
  });

  // Preâmbulo: idioma não suportado ou ausente vira undefined (quem chama
  // decide o padrão), nunca um idioma inventado.
  it("devolve undefined para idioma não suportado ou ausente", () => {
    expect(normalizeLanguage("es")).toBeUndefined();
    expect(normalizeLanguage(undefined)).toBeUndefined();
    expect(normalizeLanguage(42)).toBeUndefined();
  });
});

describe("message (mensagens fixas)", () => {
  // Preâmbulo: cada idioma tem o seu texto, e o português continua idêntico
  // ao texto que já existia (quem usa em pt não percebe mudança).
  it("traduz a mensagem de handoff e mantém o português original", () => {
    expect(message("handoff", "pt")).toBe("Vou te conectar com um atendente humano para continuar essa conversa. Só um instante.");
    expect(message("handoff", "en")).toMatch(/human agent/);
    expect(message("handoff", "it")).toMatch(/operatore/);
  });

  // Preâmbulo: sem idioma, cai no português.
  it("usa português quando o idioma não é informado", () => {
    expect(message("closedByAttendant", undefined)).toMatch(/^Atendimento encerrado/);
  });
});

describe("buildSystemPrompt (idioma)", () => {
  // Preâmbulo: com idioma informado, a instrução é explícita e pede pra
  // traduzir o contexto (que está em português).
  it("instrui o idioma informado pelo canal", () => {
    expect(buildSystemPrompt([], "en")).toMatch(/Responda SEMPRE em inglês/);
    expect(buildSystemPrompt([], "it")).toMatch(/Responda SEMPRE em italiano/);
  });

  // Preâmbulo: sem idioma (ex.: WhatsApp), segue o idioma da mensagem.
  it("sem idioma, manda seguir o idioma do cliente", () => {
    expect(buildSystemPrompt([])).toMatch(/mesmo idioma em que o cliente escreveu/);
  });
});
