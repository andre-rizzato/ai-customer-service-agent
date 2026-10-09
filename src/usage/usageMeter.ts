// Medidor de consumo de API — registra, a cada chamada paga a um provedor
// externo (LLM, embeddings, rerank), quantos tokens foram gastos, por qual
// modelo e em qual conversa. Existe para responder "quanto custa atender
// este cliente?" com número medido, não estimado: é o que permite repassar
// o custo de API ao cliente (mensalidade com franquia, repasse com margem,
// preço por conversa) sem chutar. O relatório que lê este log fica em
// src/usage/usageReport.ts (cálculo) + scripts/usageReport.ts (CLI).
//
// Por que AsyncLocalStorage: as chamadas pagas acontecem em lugares que NÃO
// conhecem a conversa — hyde.ts e knowledgeBase.ts recebem só o texto da
// pergunta, e os providers só recebem prompt/histórico. Passar
// conversationId como parâmetro por toda essa cadeia mudaria a assinatura
// de LLMProvider, EmbeddingProvider, KnowledgeBase.search() e rerank() só
// para contabilidade. Com AsyncLocalStorage, o Orchestrator abre um
// "contexto" no começo de handleMessage() e qualquer código chamado dali
// pra baixo (mesmo depois de vários `await`) enxerga esse contexto, sem
// nenhuma assinatura mudar.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env } from "../config.js";
import type { ChannelName } from "../types.js";

// Contexto de quem está gastando: a conversa e o canal da mensagem que
// disparou a chamada. Os dois são opcionais porque existem gastos fora de
// conversa (ex.: `npm run ingest` embedando o catálogo inteiro) — esses
// entram no log sem conversationId e o relatório os mostra como custo de
// "indexação", separado do custo por atendimento.
export interface UsageContext {
  conversationId?: string;
  channel?: ChannelName;
}

// Uma linha do log de consumo. `kind` separa os três tipos de cobrança,
// que os provedores precificam de forma diferente:
//   - "llm": cobra entrada e saída separadas (saída é bem mais cara);
//   - "embedding" e "rerank": cobram só tokens de entrada (não geram texto).
// `purpose` diz POR QUE a chamada aconteceu ("reply" = resposta ao
// cliente, "hyde" = passagem hipotética do RAG, "query" = embedding da
// busca, "ingest" = indexação) — útil pra saber qual etapa do pipeline
// pesa mais na conta, e decidir, por exemplo, se o HyDE vale o que custa.
export interface UsageEntry {
  kind: "llm" | "embedding" | "rerank";
  provider: "anthropic" | "openai" | "voyage";
  model: string;
  purpose?: string;
  inputTokens: number;
  outputTokens?: number;
  // Tokens de prompt caching da Anthropic. Hoje o projeto não usa
  // cache_control, então devem vir 0 — mas são gravados mesmo assim pra o
  // relatório já precificar certo (escrita de cache custa mais que entrada
  // normal, leitura custa bem menos) no dia em que o caching for ligado.
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// Formato gravado em disco: a entrada + o contexto + o horário. `ts` em ISO
// (e não epoch) porque o relatório agrupa por mês com um simples
// ts.slice(0, 7), e porque fica legível pra quem abrir o arquivo à mão.
export interface UsageRecord extends UsageEntry, UsageContext {
  ts: string;
}

// Instância única do armazenamento de contexto, compartilhada pelo
// processo inteiro — cada `run()` cria um escopo isolado, então duas
// mensagens sendo atendidas em paralelo (dois clientes ao mesmo tempo) não
// misturam seus conversationIds.
const storage = new AsyncLocalStorage<UsageContext>();

// Caminho resolvido uma vez; a pasta é criada na primeira gravação (e não
// no import) pra um teste que importa este módulo não criar pasta à toa.
const usageLogPath = resolve(env.USAGE_LOG_PATH);
let dirEnsured = false;

// Preâmbulo: runWithUsageContext() executa `fn` dentro de um contexto de
// consumo — toda chamada a recordUsage() feita durante `fn` (inclusive
// depois de awaits) é atribuída a esse contexto. Chamado pelo Orchestrator
// em volta de cada mensagem de cliente.
export function runWithUsageContext<T>(context: UsageContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

// Preâmbulo: recordUsage() grava uma linha no log de consumo. Chamado pelos
// providers (src/llm/*, src/embeddings/*, src/knowledge/reranker.ts) logo
// depois de cada resposta bem-sucedida de API.
//
// NUNCA lança: contabilidade é secundária ao atendimento. Se o disco
// encher ou a pasta estiver sem permissão, o cliente ainda precisa receber
// a resposta — por isso o erro vira só um console.error. appendFileSync
// (síncrono) pelo mesmo motivo do audit-log em store.ts: é uma linha curta,
// O(1) em relação ao tamanho do arquivo, e evita linhas intercaladas de
// duas gravações concorrentes.
export function recordUsage(entry: UsageEntry): void {
  try {
    if (!dirEnsured) {
      mkdirSync(dirname(usageLogPath), { recursive: true });
      dirEnsured = true;
    }
    const record: UsageRecord = { ts: new Date().toISOString(), ...storage.getStore(), ...entry };
    appendFileSync(usageLogPath, JSON.stringify(record) + "\n", "utf-8");
  } catch (err) {
    console.error("Falha ao gravar consumo de API (o atendimento segue normalmente):", err);
  }
}
