// Relatório de custo de API por mês — `npm run usage:report`.
//
// Uso:
//   npm run usage:report                          -> todos os meses + detalhe do mais recente
//   npm run usage:report -- --month 2026-10       -> detalhe de outubro/2026
//   npm run usage:report -- --usd-brl 5.40        -> mostra também em reais, com essa cotação
//   npm run usage:report -- --file caminho.jsonl  -> lê outro log (ex.: copiado da VM)
//
// Na VM, cada cliente roda num processo próprio com a sua pasta data/ (ver
// "Implantação multi-tenant" no CLAUDE.md), então o log de cada pasta JÁ É
// o consumo de um cliente só — rodar este script na pasta do cliente dá a
// conta dele.
//
// Não importa src/config.ts de propósito: config.ts valida o .env inteiro
// (e pode buscar segredos no Key Vault), e um relatório só de leitura não
// deveria falhar porque falta, por exemplo, o token do Telegram. Por isso
// lê USAGE_LOG_PATH direto de process.env, com o mesmo default.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildMonthReports, formatReport, parseUsageLog, type PricingTable } from "../src/usage/usageReport.js";

// Preâmbulo: argValue() lê o valor de uma flag "--nome valor". Parser
// mínimo à mão em vez de uma dependência nova — são só quatro flags.
function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const logPath = resolve(argValue("file") ?? process.env.USAGE_LOG_PATH ?? "./data/usage-log.jsonl");
const pricingPath = resolve(argValue("pricing") ?? "./config/pricing.json");
const usdBrlArg = argValue("usd-brl");
const usdBrl = usdBrlArg ? Number(usdBrlArg) : undefined;

if (usdBrl !== undefined && !(usdBrl > 0)) {
  console.error(`--usd-brl inválido: "${usdBrlArg}" (use ponto decimal, ex.: 5.40)`);
  process.exit(1);
}
if (!existsSync(logPath)) {
  // Mensagem explicativa em vez de stack trace: o caso mais comum é o
  // processo ainda não ter atendido nenhuma mensagem desde que a medição
  // foi implantada.
  console.error(`Log de consumo não encontrado em ${logPath}. Ele é criado na primeira chamada de API depois do deploy da medição.`);
  process.exit(1);
}

const pricing = JSON.parse(readFileSync(pricingPath, "utf-8")) as PricingTable;
const reports = buildMonthReports(parseUsageLog(readFileSync(logPath, "utf-8")), pricing);
if (reports.length === 0) {
  console.log("Log de consumo vazio.");
  process.exit(0);
}

// Sem --month, detalha o mês mais recente que tem registro (e não o mês do
// relógio), pra rodar no dia 1º ainda mostrar o mês que acabou de fechar.
const detailMonth = argValue("month") ?? reports[reports.length - 1].month;
console.log(formatReport(reports, detailMonth, usdBrl));
console.log(`\nPreços de config/pricing.json (conferidos em ${pricing.checkedAt ?? "data não informada"}).`);
