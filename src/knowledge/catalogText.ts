// Texto do catálogo inteiro, usado como REFERÊNCIA pela checagem de valores
// da resposta (src/orchestrator/outputGuard.ts, 09/10/2026): todo preço e
// porcentagem que o bot citar precisa existir no catálogo.
//
// Lê o mesmo arquivo que `npm run ingest` indexa (agentConfig.knowledgeBasePath),
// e não o Qdrant: a checagem precisa do catálogo inteiro a cada resposta, e
// ler um JSON local de poucos KB é instantâneo e não depende de rede. Fica
// fora do outputGuard.ts pra ele continuar uma função pura (testável sem
// .env nem disco).
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { agentConfig } from "../config.js";
import type { KnowledgeItem } from "../types.js";

// Cache do texto, invalidado pela data de modificação do arquivo: o
// catálogo é editado à mão e reindexado com `npm run ingest`, sem reiniciar
// o servidor — reler a cada resposta seria desperdício, e nunca reler
// deixaria a checagem com preços velhos (bloqueando o preço novo).
let cached: { path: string; mtimeMs: number; text: string } | undefined;

// Preâmbulo: catalogText() devolve título + conteúdo de todos os itens do
// catálogo, um por linha. Chamada pelo Orchestrator a cada resposta do LLM.
// Se o arquivo não puder ser lido, devolve string vazia e loga: a checagem
// fica mais restritiva (só os trechos recuperados valem), nunca mais
// frouxa, e o atendimento continua.
export function catalogText(): string {
  const path = resolve(agentConfig.knowledgeBasePath);
  try {
    const { mtimeMs } = statSync(path);
    if (cached && cached.path === path && cached.mtimeMs === mtimeMs) return cached.text;
    const items = JSON.parse(readFileSync(path, "utf-8")) as KnowledgeItem[];
    const text = items.map((i) => `${i.title}\n${i.content}`).join("\n");
    cached = { path, mtimeMs, text };
    return text;
  } catch (err) {
    console.error(`Não foi possível ler o catálogo (${path}) para a checagem de valores:`, err);
    return "";
  }
}
