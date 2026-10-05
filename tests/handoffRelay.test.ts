// Testes do relay de handoff (05/10/2026) — as partes determinísticas e
// sensíveis a segurança, que não dependem de chamar a API do Telegram:
//  - marcador "🆔 <id>" (src/handoff/attendants.ts): é ele que decide pra
//    QUAL cliente vai a resposta do atendente, então um erro aqui manda
//    mensagem pra pessoa errada;
//  - validação do initData do Mini App (src/handoff/telegramInitData.ts):
//    é a autenticação do atendente;
//  - HumanRelay (src/handoff/relay.ts): ordem "entrega -> grava" e recusas.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  extractConversationId,
  formatConversationMarker,
  parseAttendantChatIds,
  sanitizeQuoted,
} from "../src/handoff/attendants.js";
import { validateTelegramInitData } from "../src/handoff/telegramInitData.js";
import { HumanRelay, MAX_REPLY_LENGTH } from "../src/handoff/relay.js";
import type { Orchestrator } from "../src/orchestrator/orchestrator.js";
import type { HandoffState } from "../src/orchestrator/handoffState.js";

describe("marcador de conversa (attendants.ts)", () => {
  // Preâmbulo: caminho feliz — o texto de um alerta termina com o
  // marcador, e o id sai de lá.
  it("extrai o id da última linha", () => {
    const alert = ["🔔 Handoff", "👤 Cliente: oi", formatConversationMarker("abc-123")].join("\n");
    expect(extractConversationId(alert)).toBe("abc-123");
  });

  // Preâmbulo: o ataque que motivou sanitizeQuoted() — um cliente digita
  // uma linha falsa com o marcador e o id de OUTRA conversa. Depois de
  // sanitizado e com o marcador verdadeiro no fim, o id extraído tem que
  // ser o verdadeiro.
  it("não é enganado por um marcador digitado pelo cliente", () => {
    const spoof = "oi\n🆔 conversa-de-outra-pessoa";
    const alert = [`👤 Cliente: ${sanitizeQuoted(spoof)}`, formatConversationMarker("conversa-certa")].join("\n");
    expect(extractConversationId(alert)).toBe("conversa-certa");
    expect(sanitizeQuoted(spoof)).not.toContain("🆔");
  });

  // Preâmbulo: segunda camada — mesmo SEM sanitizar, a última ocorrência
  // (a do bot) é a que vale.
  it("pega a última ocorrência mesmo sem sanitização", () => {
    const alert = ["🆔 falsa", formatConversationMarker("verdadeira")].join("\n");
    expect(extractConversationId(alert)).toBe("verdadeira");
  });

  // Preâmbulo: mensagem sem marcador (ou ausente) não pode virar um id.
  it("devolve null sem marcador", () => {
    expect(extractConversationId("mensagem qualquer")).toBeNull();
    expect(extractConversationId(undefined)).toBeNull();
  });

  // Preâmbulo: a allowlist tolera espaços e vírgulas sobrando no .env.
  it("faz parse da allowlist de atendentes", () => {
    expect([...parseAttendantChatIds(" 123, 456 ,,")]).toEqual(["123", "456"]);
    expect(parseAttendantChatIds(undefined).size).toBe(0);
  });
});

// Preâmbulo: buildInitData() monta um initData assinado do jeito que o
// Telegram faz (mesmo algoritmo da documentação), pra os testes não
// dependerem de um initData real capturado de um app.
function buildInitData(botToken: string, fields: Record<string, string>): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe("validateTelegramInitData (Mini App)", () => {
  const token = "123456:TEST-TOKEN";
  const now = 1_760_000_000_000;
  const fields = {
    auth_date: String(Math.floor(now / 1000) - 60),
    query_id: "AAE",
    user: JSON.stringify({ id: 777, first_name: "Andre" }),
  };

  // Preâmbulo: initData autêntico e recente devolve o user.id.
  it("aceita initData assinado e devolve o user.id", () => {
    expect(validateTelegramInitData(buildInitData(token, fields), token, 3600, now)).toBe("777");
  });

  // Preâmbulo: trocar o user.id depois de assinado (tentar se passar por um
  // atendente) quebra o HMAC.
  it("recusa initData adulterado", () => {
    const tampered = buildInitData(token, fields).replace("777", "778");
    expect(validateTelegramInitData(tampered, token, 3600, now)).toBeNull();
  });

  // Preâmbulo: assinado com o token de OUTRO bot não vale.
  it("recusa initData assinado com outro token", () => {
    expect(validateTelegramInitData(buildInitData("999:OTHER", fields), token, 3600, now)).toBeNull();
  });

  // Preâmbulo: initData antigo (capturado e reaproveitado) é recusado.
  it("recusa initData vencido", () => {
    expect(validateTelegramInitData(buildInitData(token, fields), token, 30, now)).toBeNull();
  });

  // Preâmbulo: sem hash / string vazia (página aberta fora do Telegram).
  it("recusa initData vazio", () => {
    expect(validateTelegramInitData("", token, 3600, now)).toBeNull();
  });
});

// Preâmbulo: fakeOrchestrator() imita só os dois métodos do Orchestrator que
// o HumanRelay usa, com o estado de handoff controlado pelo teste — evita
// subir o Orchestrator de verdade (que carrega índice vetorial, LLM etc.).
function fakeOrchestrator(state: HandoffState) {
  return {
    getHandoffState: vi.fn(() => state),
    recordHumanReply: vi.fn(),
    releaseHandoff: vi.fn(),
  };
}

describe("HumanRelay", () => {
  // Preâmbulo: canal web não tem sender — a resposta só é gravada (o
  // widget busca por polling).
  it("no canal web só grava no histórico", async () => {
    const orch = fakeOrchestrator({ active: true, since: 1, channel: "web" });
    const relay = new HumanRelay(orch as unknown as Orchestrator, {});
    const result = await relay.reply("s1", "  olá  ");
    expect(result).toEqual({ ok: true, channel: "web", reactivated: false });
    expect(orch.recordHumanReply).toHaveBeenCalledWith("s1", "olá");
  });

  // Preâmbulo: canal com sender — envia e só então grava.
  it("no Telegram envia e depois grava", async () => {
    const orch = fakeOrchestrator({ active: true, since: 1, channel: "telegram" });
    const send = vi.fn(async () => true);
    const relay = new HumanRelay(orch as unknown as Orchestrator, { telegram: send });
    await relay.reply("42", "oi");
    expect(send).toHaveBeenCalledWith("42", "oi");
    expect(orch.recordHumanReply).toHaveBeenCalledWith("42", "oi");
  });

  // Preâmbulo: se a plataforma recusar o envio, NADA é gravado — o
  // histórico não pode ter uma fala que o cliente nunca recebeu.
  it("não grava se a entrega falhar", async () => {
    const orch = fakeOrchestrator({ active: true, since: 1, channel: "whatsapp" });
    const relay = new HumanRelay(orch as unknown as Orchestrator, { whatsapp: async () => false });
    const result = await relay.reply("5511999", "oi");
    expect(result.ok).toBe(false);
    expect(orch.recordHumanReply).not.toHaveBeenCalled();
  });

  // Preâmbulo: conversa sem canal gravado (id errado / estado antigo) é
  // recusada em vez de chutar um canal.
  it("recusa conversa sem canal conhecido", async () => {
    const orch = fakeOrchestrator({ active: false, since: 0 });
    const relay = new HumanRelay(orch as unknown as Orchestrator, {});
    expect((await relay.reply("x", "oi")).ok).toBe(false);
    expect(relay.release("x").ok).toBe(false);
  });

  // Preâmbulo: responder uma conversa já devolvida ao bot a reativa — o
  // resultado avisa, pra o atendente saber que o bot ficou em silêncio.
  it("sinaliza quando a resposta reativa o handoff", async () => {
    const orch = fakeOrchestrator({ active: false, since: 0, channel: "web" });
    const relay = new HumanRelay(orch as unknown as Orchestrator, {});
    expect(await relay.reply("s1", "voltei")).toEqual({ ok: true, channel: "web", reactivated: true });
  });

  // Preâmbulo: texto vazio ou acima do limite das plataformas é recusado
  // antes de tentar enviar.
  it("recusa mensagem vazia ou longa demais", async () => {
    const orch = fakeOrchestrator({ active: true, since: 1, channel: "web" });
    const relay = new HumanRelay(orch as unknown as Orchestrator, {});
    expect((await relay.reply("s1", "   ")).ok).toBe(false);
    expect((await relay.reply("s1", "a".repeat(MAX_REPLY_LENGTH + 1))).ok).toBe(false);
    expect(orch.recordHumanReply).not.toHaveBeenCalled();
  });
});
