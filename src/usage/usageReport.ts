// Cálculo do relatório de custo de API — lê as linhas gravadas por
// src/usage/usageMeter.ts, aplica a tabela de preços (config/pricing.json)
// e resume por mês: total, custo por conversa, por resposta, por etapa do
// pipeline e por modelo. Funções PURAS (sem ler disco nem imprimir) de
// propósito: o script de linha de comando (scripts/usageReport.ts) cuida de
// I/O, e os testes (tests/usageReport.test.ts) checam a matemática sem
// precisar de arquivo de verdade.
//
// Para que serve na prática: decidir o preço do serviço ao cliente. Com
// "custo médio por conversa" e "conversas por mês" medidos, dá pra montar
// uma mensalidade com franquia (ex.: até N conversas) que cubra a API com
// margem, ou um repasse "custo + X%".
import type { UsageRecord } from "./usageMeter.js";

// Preço de um modelo, em USD por 1 milhão de tokens. Só `input` é
// obrigatório: embeddings e rerank não têm saída nem cache.
export interface ModelPrice {
  input: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface PricingTable {
  checkedAt?: string;
  models: Record<string, ModelPrice>;
}

// Resumo de UM mês. Valores em USD — a conversão pra real é feita só na
// formatação (formatReport), com a cotação passada na linha de comando,
// porque o provedor cobra em dólar e a cotação muda; gravar em real
// esconderia de onde veio o número.
export interface MonthReport {
  month: string;
  totalUsd: number;
  // Custo de indexação do catálogo (`npm run ingest`): não pertence a
  // nenhuma conversa, então fica fora da média por conversa — senão um
  // mês com reindexação pareceria ter conversas mais caras.
  ingestUsd: number;
  conversations: number;
  // Conversas no sentido da COBRANÇA (knowledge/catalog.json, item "O que
  // conta como uma conversa"): cada par cliente × dia, no horário de
  // Brasília. Diferente de `conversations` (ids distintos no mês): no
  // WhatsApp o id é o telefone, então um cliente que volta todo dia seria 1
  // em `conversations` e 30 aqui. É este número que se compara com a
  // franquia do plano.
  billableConversations: number;
  replies: number;
  avgPerConversationUsd: number;
  medianPerConversationUsd: number;
  maxPerConversationUsd: number;
  avgPerReplyUsd: number;
  byPurpose: Record<string, number>;
  byModel: Record<string, { usd: number; inputTokens: number; outputTokens: number; calls: number }>;
  byChannel: Record<string, number>;
  topConversations: { conversationId: string; usd: number; replies: number }[];
  // Modelos que apareceram no log mas não têm preço na tabela — listados
  // em vez de somados como zero, pra ninguém fechar uma conta achando que
  // aquele consumo saiu de graça.
  unpricedModels: string[];
}

// Preâmbulo: parseUsageLog() transforma o conteúdo do arquivo JSON Lines
// em registros. Linha vazia ou corrompida (ex.: processo morto no meio de
// uma escrita) é ignorada em vez de abortar o relatório inteiro — uma
// linha perdida distorce menos do que relatório nenhum.
export function parseUsageLog(text: string): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as UsageRecord);
    } catch {
      // Linha inválida: segue para a próxima (ver preâmbulo).
    }
  }
  return records;
}

// Preâmbulo: findPrice() acha o preço de um modelo pelo MAIOR prefixo que
// casar. Prefixo porque a API devolve o nome com data
// ("claude-haiku-4-5-20251001") e a tabela fica mais simples sem ela; o
// MAIOR prefixo porque "rerank-2" também é prefixo de "rerank-2-lite", e o
// modelo lite (mais barato) não pode ser cobrado como o normal.
export function findPrice(model: string, pricing: PricingTable): ModelPrice | undefined {
  let best: string | undefined;
  for (const key of Object.keys(pricing.models)) {
    if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? pricing.models[best] : undefined;
}

// Preâmbulo: costOfRecord() calcula o custo em USD de uma linha do log.
// Devolve undefined quando o modelo não tem preço (ver unpricedModels).
// Nas chamadas de LLM da Anthropic, input_tokens JÁ exclui os tokens de
// cache — por isso os três são somados, cada um com seu preço, sem
// descontar nada.
export function costOfRecord(record: UsageRecord, pricing: PricingTable): number | undefined {
  const price = findPrice(record.model, pricing);
  if (!price) return undefined;
  const perToken = (usdPerMillion: number | undefined) => (usdPerMillion ?? 0) / 1_000_000;
  return (
    record.inputTokens * perToken(price.input) +
    (record.outputTokens ?? 0) * perToken(price.output) +
    // Sem preço de cache na tabela, cobra como entrada normal — é o
    // palpite conservador (na prática leitura de cache é mais barata).
    (record.cacheReadTokens ?? 0) * perToken(price.cacheRead ?? price.input) +
    (record.cacheWriteTokens ?? 0) * perToken(price.cacheWrite ?? price.input)
  );
}

// Preâmbulo: buildMonthReports() agrupa os registros por mês (AAAA-MM do
// horário UTC gravado) e calcula o resumo de cada um, do mais antigo para o
// mais recente. Chamado pelo script scripts/usageReport.ts.
export function buildMonthReports(records: UsageRecord[], pricing: PricingTable): MonthReport[] {
  const byMonth = new Map<string, UsageRecord[]>();
  for (const r of records) {
    const month = r.ts.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month)!.push(r);
  }
  return [...byMonth.keys()].sort().map((month) => buildMonthReport(month, byMonth.get(month)!, pricing));
}

// Preâmbulo: buildMonthReport() faz a conta de um único mês. Separado de
// buildMonthReports() só pra deixar o agrupamento e a soma legíveis cada um
// no seu canto.
function buildMonthReport(month: string, records: UsageRecord[], pricing: PricingTable): MonthReport {
  let totalUsd = 0;
  let ingestUsd = 0;
  const unpriced = new Set<string>();
  const byPurpose: Record<string, number> = {};
  const byModel: MonthReport["byModel"] = {};
  const byChannel: Record<string, number> = {};
  // Por conversa: custo acumulado e quantas respostas do LLM ao cliente
  // (purpose "reply") ela teve — respostas, e não mensagens recebidas,
  // porque é a resposta que gera custo (mensagem que caiu em handoff por
  // palavra-chave não chama API nenhuma).
  const perConversation = new Map<string, { usd: number; replies: number }>();
  // Pares "conversationId|dia" — ver billableConversations em MonthReport.
  const billable = new Set<string>();

  for (const r of records) {
    const usd = costOfRecord(r, pricing);
    if (usd === undefined) {
      unpriced.add(r.model);
      continue;
    }
    totalUsd += usd;

    const purpose = r.purpose ?? (r.conversationId ? "outros" : "ingest");
    byPurpose[purpose] = (byPurpose[purpose] ?? 0) + usd;

    const model = (byModel[r.model] ??= { usd: 0, inputTokens: 0, outputTokens: 0, calls: 0 });
    model.usd += usd;
    model.inputTokens += r.inputTokens + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);
    model.outputTokens += r.outputTokens ?? 0;
    model.calls += 1;

    // Sem conversationId = gasto fora de atendimento (indexação do
    // catálogo). Fica no total, mas fora das médias por conversa.
    if (!r.conversationId) {
      ingestUsd += usd;
      continue;
    }
    if (r.channel) byChannel[r.channel] = (byChannel[r.channel] ?? 0) + usd;
    const conv = perConversation.get(r.conversationId) ?? { usd: 0, replies: 0 };
    conv.usd += usd;
    if (r.kind === "llm" && r.purpose === "reply") conv.replies += 1;
    perConversation.set(r.conversationId, conv);
    billable.add(`${r.conversationId}|${brasiliaDate(r.ts)}`);
  }

  const convCosts = [...perConversation.values()].map((c) => c.usd).sort((a, b) => a - b);
  const conversations = convCosts.length;
  const replies = [...perConversation.values()].reduce((sum, c) => sum + c.replies, 0);
  const conversationUsd = totalUsd - ingestUsd;

  return {
    month,
    totalUsd,
    ingestUsd,
    conversations,
    billableConversations: billable.size,
    replies,
    avgPerConversationUsd: conversations ? conversationUsd / conversations : 0,
    medianPerConversationUsd: median(convCosts),
    maxPerConversationUsd: conversations ? convCosts[conversations - 1] : 0,
    avgPerReplyUsd: replies ? conversationUsd / replies : 0,
    byPurpose,
    byModel,
    byChannel,
    topConversations: [...perConversation.entries()]
      .map(([conversationId, c]) => ({ conversationId, usd: c.usd, replies: c.replies }))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 5),
    unpricedModels: [...unpriced].sort(),
  };
}

// Mediana além da média porque poucas conversas muito longas puxam a
// média pra cima — a mediana mostra o custo da conversa "típica", que é o
// número certo pra dimensionar uma franquia.
// Preâmbulo: brasiliaDate() devolve a data (AAAA-MM-DD) de um horário ISO
// em UTC convertida para o horário de Brasília (UTC−3, sem horário de verão
// desde 2019). Usada pra contar "conversa = cliente × dia" no dia que o
// cliente enxerga: sem a conversão, uma mensagem às 22h de Brasília (01h
// UTC) cairia no dia seguinte e contaria uma conversa a mais.
export function brasiliaDate(isoTs: string): string {
  return new Date(Date.parse(isoTs) - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Preâmbulo: formatReport() transforma os resumos em texto pro terminal.
// `usdBrl` (cotação) é opcional: quando informado, cada valor aparece
// também em reais, que é a moeda em que o cliente vai ser cobrado.
// `detailMonth` escolhe qual mês ganha o detalhamento completo (os outros
// aparecem só na tabela de totais).
export function formatReport(reports: MonthReport[], detailMonth: string, usdBrl?: number): string {
  const money = (usd: number) => {
    // 4 casas em dólar porque o custo por resposta costuma ser fração de
    // centavo — com 2 casas tudo apareceria como $0.00.
    const base = `US$ ${usd.toFixed(4)}`;
    return usdBrl ? `${base} (R$ ${(usd * usdBrl).toFixed(4)})` : base;
  };
  const lines: string[] = [];

  lines.push("Custo de API por mês");
  for (const r of reports) {
    lines.push(`  ${r.month}: ${money(r.totalUsd)} | ${r.billableConversations} conversas cobráveis | ${r.replies} respostas`);
  }

  const d = reports.find((r) => r.month === detailMonth);
  if (!d) {
    lines.push("", `Nenhum consumo registrado em ${detailMonth}.`);
    return lines.join("\n");
  }

  lines.push("", `Detalhe de ${d.month}`);
  lines.push(`  Total:                    ${money(d.totalUsd)}`);
  lines.push(`  Indexação do catálogo:    ${money(d.ingestUsd)}`);
  lines.push(`  Conversas cobráveis:      ${d.billableConversations} (cliente × dia — compare com a franquia do plano)`);
  lines.push(`  Clientes distintos:       ${d.conversations}`);
  lines.push(`  Custo médio por conversa: ${money(d.avgPerConversationUsd)}`);
  lines.push(`  Mediana por conversa:     ${money(d.medianPerConversationUsd)}`);
  lines.push(`  Conversa mais cara:       ${money(d.maxPerConversationUsd)}`);
  lines.push(`  Custo médio por resposta: ${money(d.avgPerReplyUsd)}`);

  lines.push("", "  Por etapa:");
  for (const [purpose, usd] of Object.entries(d.byPurpose).sort((a, b) => b[1] - a[1])) {
    lines.push(`    ${purpose.padEnd(10)} ${money(usd)}`);
  }
  lines.push("", "  Por modelo:");
  for (const [model, m] of Object.entries(d.byModel).sort((a, b) => b[1].usd - a[1].usd)) {
    lines.push(`    ${model}: ${money(m.usd)} | ${m.calls} chamadas | ${m.inputTokens} tokens entrada | ${m.outputTokens} saída`);
  }
  if (Object.keys(d.byChannel).length) {
    lines.push("", "  Por canal:");
    for (const [channel, usd] of Object.entries(d.byChannel)) lines.push(`    ${channel.padEnd(10)} ${money(usd)}`);
  }
  lines.push("", "  Conversas mais caras:");
  for (const c of d.topConversations) lines.push(`    ${c.conversationId}: ${money(c.usd)} (${c.replies} respostas)`);
  if (d.unpricedModels.length) {
    lines.push("", `  ATENÇÃO: modelos sem preço em config/pricing.json (custo NÃO somado): ${d.unpricedModels.join(", ")}`);
  }
  return lines.join("\n");
}
