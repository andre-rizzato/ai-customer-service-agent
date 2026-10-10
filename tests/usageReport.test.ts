// Testes do relatório de custo de API (src/usage/usageReport.ts). O que
// importa garantir aqui é a MATEMÁTICA que vai virar cobrança ao cliente:
// preço certo por modelo (inclusive o prefixo mais longo), indexação fora
// da média por conversa, e modelo sem preço nunca contado como zero.
import { describe, expect, it } from "vitest";
import { brasiliaDate, buildMonthReports, costOfRecord, findPrice, parseUsageLog, type PricingTable } from "../src/usage/usageReport.js";
import type { UsageRecord } from "../src/usage/usageMeter.js";

const pricing: PricingTable = {
  models: {
    "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    "voyage-3.5-lite": { input: 0.02 },
    "rerank-2": { input: 0.05 },
    "rerank-2-lite": { input: 0.02 },
  },
};

// Atalho pra montar um registro com os campos que cada teste não liga.
function rec(partial: Partial<UsageRecord>): UsageRecord {
  return { ts: "2026-10-09T12:00:00.000Z", kind: "llm", provider: "anthropic", model: "claude-haiku-4-5-20251001", inputTokens: 0, ...partial };
}

describe("findPrice", () => {
  it("casa o modelo com data pelo prefixo", () => {
    expect(findPrice("claude-haiku-4-5-20251001", pricing)?.input).toBe(1);
  });

  it("escolhe o prefixo MAIS LONGO (rerank-2-lite não pode ser cobrado como rerank-2)", () => {
    expect(findPrice("rerank-2-lite", pricing)?.input).toBe(0.02);
    expect(findPrice("rerank-2", pricing)?.input).toBe(0.05);
  });
});

describe("costOfRecord", () => {
  it("soma entrada, saída e cache, cada um com seu preço", () => {
    const usd = costOfRecord(
      rec({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }),
      pricing
    );
    expect(usd).toBeCloseTo(1 + 5 + 0.1 + 1.25);
  });

  it("devolve undefined pra modelo sem preço (nunca zero)", () => {
    expect(costOfRecord(rec({ model: "modelo-desconhecido", inputTokens: 10 }), pricing)).toBeUndefined();
  });
});

describe("buildMonthReports", () => {
  const records: UsageRecord[] = [
    // Conversa A: HyDE + resposta + embedding + rerank.
    rec({ conversationId: "a", channel: "telegram", purpose: "hyde", inputTokens: 100_000, outputTokens: 20_000 }),
    rec({ conversationId: "a", channel: "telegram", purpose: "reply", inputTokens: 200_000, outputTokens: 40_000 }),
    rec({ conversationId: "a", channel: "telegram", kind: "embedding", provider: "voyage", model: "voyage-3.5-lite", purpose: "query", inputTokens: 1_000_000 }),
    // Conversa B: duas respostas.
    rec({ conversationId: "b", channel: "web", purpose: "reply", inputTokens: 100_000 }),
    rec({ conversationId: "b", channel: "web", purpose: "reply", inputTokens: 100_000 }),
    // Indexação (sem conversa) — 1 USD de embedding.
    rec({ kind: "embedding", provider: "voyage", model: "voyage-3.5-lite", purpose: "ingest", inputTokens: 50_000_000 }),
    // Mês anterior.
    rec({ ts: "2026-09-30T23:59:00.000Z", conversationId: "c", purpose: "reply", inputTokens: 1_000_000 }),
    // Modelo sem preço.
    rec({ conversationId: "b", model: "gpt-9", inputTokens: 999 }),
  ];
  const reports = buildMonthReports(records, pricing);
  const oct = reports.find((r) => r.month === "2026-10")!;

  it("separa os meses em ordem", () => {
    expect(reports.map((r) => r.month)).toEqual(["2026-09", "2026-10"]);
  });

  it("deixa a indexação no total mas fora da média por conversa", () => {
    // A = 0.1 + 0.1 (hyde) + 0.2 + 0.2 (reply) + 0.02 (embedding) = 0.62; B = 0.2
    expect(oct.ingestUsd).toBeCloseTo(1);
    expect(oct.totalUsd).toBeCloseTo(1 + 0.62 + 0.2);
    expect(oct.conversations).toBe(2);
    expect(oct.avgPerConversationUsd).toBeCloseTo((0.62 + 0.2) / 2);
    expect(oct.maxPerConversationUsd).toBeCloseTo(0.62);
  });

  it("conta só as respostas ao cliente (purpose reply) no custo por resposta", () => {
    expect(oct.replies).toBe(3);
    expect(oct.avgPerReplyUsd).toBeCloseTo((0.62 + 0.2) / 3);
  });

  it("lista modelo sem preço em vez de somar zero", () => {
    expect(oct.unpricedModels).toEqual(["gpt-9"]);
  });
});

describe("conversas cobráveis (cliente × dia, horário de Brasília)", () => {
  it("o mesmo cliente em dois dias conta 2; duas mensagens no mesmo dia contam 1", () => {
    const [oct] = buildMonthReports(
      [
        rec({ conversationId: "5511999", ts: "2026-10-10T13:00:00.000Z", purpose: "reply", inputTokens: 1 }),
        rec({ conversationId: "5511999", ts: "2026-10-10T18:00:00.000Z", purpose: "reply", inputTokens: 1 }),
        rec({ conversationId: "5511999", ts: "2026-10-11T13:00:00.000Z", purpose: "reply", inputTokens: 1 }),
      ],
      pricing
    );
    expect(oct.conversations).toBe(1);
    expect(oct.billableConversations).toBe(2);
  });

  it("22h de Brasília (01h UTC do dia seguinte) ainda é o mesmo dia", () => {
    expect(brasiliaDate("2026-10-11T01:00:00.000Z")).toBe("2026-10-10");
    expect(brasiliaDate("2026-10-11T03:00:00.000Z")).toBe("2026-10-11");
  });
});

describe("parseUsageLog", () => {
  it("ignora linha vazia ou corrompida sem perder as outras", () => {
    const text = `${JSON.stringify(rec({ inputTokens: 1 }))}\n{quebrado\n\n${JSON.stringify(rec({ inputTokens: 2 }))}\n`;
    expect(parseUsageLog(text).map((r) => r.inputTokens)).toEqual([1, 2]);
  });
});
