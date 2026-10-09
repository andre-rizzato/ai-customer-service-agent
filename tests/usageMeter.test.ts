// Testes do medidor de consumo (src/usage/usageMeter.ts). O ponto crítico
// é o AsyncLocalStorage: o conversationId aberto pelo Orchestrator precisa
// chegar até a gravação mesmo depois de vários `await` (como acontece de
// verdade: HyDE -> embedding -> rerank -> resposta), e duas conversas em
// paralelo não podem trocar de dono.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// Mocka config.ts (mesmo padrão de tests/agentServiceClient.test.ts) pra
// gravar num arquivo temporário em vez de data/ do projeto. vi.hoisted
// porque vi.mock é içado pro topo do arquivo e roda antes de qualquer
// const comum — sem isso, logPath ainda não existiria dentro do mock.
const { logPath } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return { logPath: join(mkdtempSync(join(tmpdir(), "usage-")), "usage.jsonl") };
});
vi.mock("../src/config.js", () => ({ env: { USAGE_LOG_PATH: logPath } }));

import { recordUsage, runWithUsageContext } from "../src/usage/usageMeter.js";

const readLog = () =>
  readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));

describe("usageMeter", () => {
  it("atribui cada gravação à conversa certa, mesmo com awaits e em paralelo", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const conversa = (id: string) =>
      runWithUsageContext({ conversationId: id, channel: "telegram" }, async () => {
        await tick();
        recordUsage({ kind: "llm", provider: "anthropic", model: "m", purpose: id, inputTokens: 1 });
        await tick();
        recordUsage({ kind: "rerank", provider: "voyage", model: "rerank-2", purpose: id, inputTokens: 1 });
      });
    await Promise.all([conversa("a"), conversa("b")]);
    // Gravação fora de qualquer contexto (ex.: npm run ingest) sai sem conversa.
    recordUsage({ kind: "embedding", provider: "voyage", model: "v", purpose: "ingest", inputTokens: 1 });

    const lines = readLog();
    expect(lines).toHaveLength(5);
    for (const l of lines.slice(0, 4)) expect(l.conversationId).toBe(l.purpose);
    expect(lines[4].conversationId).toBeUndefined();
    expect(lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
