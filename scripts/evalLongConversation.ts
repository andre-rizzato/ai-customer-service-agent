// Teste de conversa longa — `npm run eval:long-conversation`.
//
// Por que existe: o eval RAGAS (eval/) só manda perguntas soltas, de uma
// mensagem cada, então nunca exercita a memória da conversa
// (src/conversation/memory.ts: janela dos últimos turnos + resumo + busca
// BM25 nos turnos antigos). Este script simula uma cliente que conta nome,
// cidade e situação no COMEÇO, faz 13 perguntas no meio (o bastante pra
// esses turnos saírem da janela de 15 e entrarem no resumo) e, no fim,
// pergunta coisas que só dá pra responder lembrando do começo.
//
// Foi assim que, em 09/10/2026, se confirmou que a janela + memória lembra
// tanto quanto o histórico completo (3/3 nos dois) — e que a primeira versão
// do resumo misturava características de dois produtos (ver o comentário do
// SUMMARY_SYSTEM_PROMPT em memory.ts).
//
// Pré-requisitos (iguais aos do eval/README.md):
//   - servidor rodando com o catálogo de exemplo indexado
//     (knowledge/catalog.example.json — as checagens dependem dele);
//   - rate limit do agent.config.json >= 20 mensagens/minuto (são 16).
// Cada execução chama o LLM de verdade: ~US$ 0,05 com Claude Haiku 4.5.
//
// Uso:
//   npm run eval:long-conversation                       (servidor em localhost:3000)
//   AGENT_BASE_URL=http://localhost:3999 npm run eval:long-conversation
//
// Para comparar com o comportamento antigo (histórico completo), rode o
// servidor com "historyWindowTurns": 1000 no agent.config.json.
//
// Para ver o resumo salvo e os tokens por resposta, rode este script com os
// MESMOS CONVERSATIONS_DIR e USAGE_LOG_PATH do servidor (são lidos direto do
// disco). Não importa src/config.ts pelo mesmo motivo de usageReport.ts: um
// teste só de HTTP não deveria exigir o .env inteiro válido.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const baseUrl = process.env.AGENT_BASE_URL ?? "http://localhost:3000";
// Id único por execução: rodar duas vezes seguidas não pode reaproveitar o
// histórico da execução anterior (o bot "lembraria" por outro motivo).
const conversationId = `eval-conversa-longa-${Date.now()}`;

// Preâmbulo: send() manda uma mensagem pelo canal web (o mesmo contrato do
// widget) e devolve a resposta do bot. fetch nativo, e não curl, porque o
// curl do Git Bash corrompe texto não-ASCII (ver CLAUDE.md).
async function send(text: string): Promise<string> {
  const res = await fetch(`${baseUrl}/webhook/web/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, text, language: "pt" }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} em "${text}": ${await res.text()}`);
  return ((await res.json()) as { reply: string }).reply;
}

// Começo da conversa: as três primeiras mensagens plantam os fatos que serão
// cobrados no fim (nome, cidade, restrição de aluguel -> FX100). As demais
// são perguntas comuns sobre o catálogo, que empurram o começo pra fora da
// janela. Nenhuma contém palavra-gatilho de handoff (handoffKeywords /
// frustrationKeywords), senão a conversa passaria pra um humano no meio.
const opening = [
  "oi, meu nome é Carla e moro em Curitiba",
  "moro de aluguel e não posso mexer no encanamento, qual filtro serve pra mim?",
  "legal, e qual a garantia dele?",
  "quais as formas de pagamento?",
  "tem desconto no pix?",
  "e o FX200, quanto custa?",
  "o FX200 é bivolt?",
  "de quanto em quanto tempo troca o refil do FX200?",
  "o FX200 tira cloro?",
  "tem frete grátis?",
  "posso devolver se não gostar?",
  "quem paga o frete da devolução nesse caso?",
  "e o reembolso demora quanto?",
];

// Perguntas finais e o que a resposta precisa conter. Cada uma testa uma
// forma diferente de lembrar: o nome (só no resumo), uma referência
// indireta ao produto indicado ("aquele que você me indicou") e um fato do
// catálogo que depende de um dado do começo (Curitiba é capital -> 3 a 7
// dias úteis).
const checks: [string, RegExp][] = [
  ["você lembra meu nome?", /carla/i],
  ["e qual era mesmo o filtro que você me indicou por causa do meu apartamento alugado?", /fx\s?100/i],
  ["quanto tempo demora a entrega pra minha cidade?", /3\s*(a|e|-)\s*7/i],
];

for (const message of opening) await send(message);
// O resumo é atualizado em segundo plano depois de uma resposta; a pausa dá
// tempo dele terminar antes das perguntas que dependem dele.
await new Promise((r) => setTimeout(r, 6000));

let passed = 0;
for (const [question, expected] of checks) {
  const reply = await send(question);
  const ok = expected.test(reply);
  if (ok) passed++;
  console.log(`${ok ? "OK    " : "FALHOU"} ${question}\n       -> ${reply.replace(/\s+/g, " ").slice(0, 200)}`);
}
console.log(`\nLembrou ${passed}/${checks.length} (conversa ${conversationId})`);

// Diagnóstico opcional, só se o script enxergar os arquivos do servidor.
const memoryPath = resolve(process.env.CONVERSATIONS_DIR ?? "./data/conversations", `${conversationId}.memory.json`);
if (existsSync(memoryPath)) {
  console.log("\nResumo salvo:\n" + (JSON.parse(readFileSync(memoryPath, "utf-8")) as { summary: string }).summary);
}
const usagePath = resolve(process.env.USAGE_LOG_PATH ?? "./data/usage-log.jsonl");
if (existsSync(usagePath)) {
  const replies = readFileSync(usagePath, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { conversationId?: string; purpose?: string; inputTokens: number })
    .filter((u) => u.conversationId === conversationId && u.purpose === "reply");
  // Com histórico completo esse número cresce a cada resposta; com a janela
  // ele para de crescer quando a conversa passa de historyWindowTurns.
  if (replies.length) console.log("\nTokens de entrada por resposta:", replies.map((u) => u.inputTokens).join(" "));
}

process.exit(passed === checks.length ? 0 : 1);
