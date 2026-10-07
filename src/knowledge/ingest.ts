// Script de linha de comando (não é importado por nenhum outro módulo do
// servidor) que lê o catálogo bruto (JSON) e produz o índice vetorial usado
// em tempo de resposta. Corresponde à Fase 3 do runbook: "Catalogar" +
// "Indexar". Rodado manualmente via `npm run ingest`, e deve ser rodado de
// novo toda vez que o catálogo mudar (Fase 7: "atraso aqui é a causa nº 1
// de informação errada meses depois do lançamento").
//
// Troca de armazenamento (antes: FileVectorStore em disco; agora: Qdrant) —
// mesma técnica do AgentService irmão (rag/ingest.py). O formato do
// catálogo e o resto do pipeline de ingest não mudaram.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { agentConfig } from "../config.js";
import { createEmbeddingProvider } from "../embeddings/index.js";
import { ensureCollection, replaceAll } from "./qdrantStore.js";
import type { KnowledgeItem } from "../types.js";

// Preâmbulo: main() é o ponto de entrada do script. Lê o catálogo do
// caminho configurado, embeda cada item e grava o resultado no Qdrant. É
// uma função `async` separada (em vez de código solto no topo do módulo)
// só para poder usar `await` livremente e ter um único lugar para tratar
// erro (ver o `.catch` no final do arquivo).
async function main() {
  // Resolve o caminho do catálogo configurado em agent.config.json
  // (knowledgeBasePath) para um caminho absoluto, independente de onde o
  // comando `npm run ingest` foi disparado.
  const catalogPath = resolve(agentConfig.knowledgeBasePath);
  // Lê o arquivo e faz o parse — cada item já deve seguir o formato
  // KnowledgeItem (id, title, content); não há validação de schema aqui
  // porque, diferente de config.ts, um erro de formato no catálogo é mais
  // fácil de diagnosticar (o TypeScript já reclama se o array não bater com
  // KnowledgeItem[] durante o build/typecheck).
  const items: KnowledgeItem[] = JSON.parse(readFileSync(catalogPath, "utf-8"));

  // Guarda contra catálogo vazio: evita chamar a API de embeddings com uma
  // lista vazia e sobrescrever o índice com "nada" por engano — melhor
  // avisar e sair sem tocar no Qdrant.
  if (items.length === 0) {
    console.warn("Catalog is empty — nothing to ingest.");
    return;
  }

  // Log de progresso — indexar pode levar alguns segundos dependendo do
  // provedor de embeddings e do tamanho do catálogo, então é útil o
  // operador ver que o processo começou e qual provedor está em uso.
  console.log(`Embedding ${items.length} knowledge items with provider "${process.env.EMBEDDING_PROVIDER ?? "voyage"}"...`);
  // Cria o provider de embeddings no modo "document" — importante: é o
  // mesmo tipo de embedding usado depois para as perguntas do usuário
  // precisar ser comparável (ver KnowledgeBase, que usa modo "query"); os
  // dois modos existem porque a Voyage otimiza o vetor de forma diferente
  // para cada papel, mesmo compartilhando o mesmo espaço vetorial.
  const embedder = createEmbeddingProvider("document");
  // Monta uma única lista de textos (título + conteúdo concatenados, um por
  // item) e chama embed() UMA VEZ para o lote inteiro — mais eficiente do
  // que uma chamada de API por item.
  const vectors = await embedder.embed(items.map((i) => `${i.title}\n${i.content}`));

  // Garante que a coleção existe (com a dimensão certa, descoberta a partir
  // do próprio vetor gerado acima — nunca um número cravado no código) antes
  // de gravar qualquer ponto.
  await ensureCollection(vectors[0].length);
  // Substitui o índice inteiro pelos novos pares (item, vetor) — `vectors[i]`
  // corresponde a `items[i]` porque embed() preserva a ordem de entrada
  // (contrato garantido pela interface EmbeddingProvider).
  await replaceAll(items.map((item, i) => ({ item, vector: vectors[i] })));

  // Confirmação final para o operador.
  console.log(`Ingested ${items.length} items into Qdrant.`);
}

// Executa main() e, se qualquer passo acima lançar uma exceção (arquivo não
// encontrado, chave de API inválida, etc.), imprime o erro e encerra o
// processo com código de saída 1 — importante para que `npm run ingest`
// falhe visivelmente em vez de terminar "silenciosamente com sucesso" num
// script que na verdade não indexou nada.
main().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
