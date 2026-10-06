// Testes de currentSession() (src/conversation/currentSession.ts): o corte
// do histórico depois de um atendimento humano encerrado. Reproduz a
// conversa real do bug de 06/10/2026 — sem o corte, o LLM e o alerta do
// Telegram enxergavam o "sim pode fazer" de um atendimento já encerrado.
import { describe, expect, it } from "vitest";
import { currentSession } from "../src/conversation/currentSession.js";
import type { ConversationTurn } from "../src/types.js";

const t = (role: ConversationTurn["role"], text: string, extra: Partial<ConversationTurn> = {}): ConversationTurn => ({
  role,
  text,
  timestamp: 0,
  ...extra,
});

describe("currentSession", () => {
  // Preâmbulo: sem nenhum encerramento, nada é cortado.
  it("devolve tudo quando nunca houve encerramento", () => {
    const h = [t("user", "ola"), t("assistant", "oi")];
    expect(currentSession(h)).toEqual(h);
  });

  // Preâmbulo: a conversa real do bug — depois do encerramento, só a
  // mensagem nova sobra.
  it("corta tudo antes do último atendimento encerrado (campo contextBoundary)", () => {
    const h = [
      t("user", "Nossos serviços"),
      t("assistant", "Deseja que eu transfira?"),
      t("user", "sim pode fazer"),
      t("assistant", "Atendimento encerrado. Obrigado pelo contato!", { relayed: true }),
      t("system-note", "Atendimento encerrado pelo atendente", { contextBoundary: true }),
      t("user", "Nossos serviços"),
    ];
    expect(currentSession(h).map((x) => x.text)).toEqual(["Nossos serviços"]);
  });

  // Preâmbulo: encerramentos gravados antes do campo existir (só o texto
  // da nota) também valem como corte.
  it("reconhece encerramentos antigos pelo texto da nota", () => {
    const h = [t("user", "sim pode fazer"), t("system-note", "Atendimento encerrado pelo atendente"), t("user", "oi")];
    expect(currentSession(h).map((x) => x.text)).toEqual(["oi"]);
  });

  // Preâmbulo: "Devolver ao bot" NÃO corta — o bot continua a mesma conversa.
  it("não corta em 'devolvido ao bot'", () => {
    const h = [t("human-agent", "seu pedido sai amanhã"), t("system-note", "Handoff devolvido ao bot pelo atendente"), t("user", "obrigado")];
    expect(currentSession(h)).toHaveLength(3);
  });
});
