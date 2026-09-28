// Testes do vector store em arquivo (src/knowledge/vectorStore.ts). Cobre
// tanto a matemática de similaridade (ranking correto) quanto a persistência
// em disco (dados sobrevivem entre instâncias diferentes da classe).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileVectorStore } from "../src/knowledge/vectorStore.js";

describe("FileVectorStore", () => {
  // Diretório temporário criado por cada teste que precisa de um arquivo
  // real em disco — declarado fora dos `it` para que afterEach() consiga
  // limpá-lo depois, mesmo que o teste falhe no meio.
  let dir: string;

  // Preâmbulo: afterEach roda depois de CADA teste deste describe (mesmo em
  // caso de falha), removendo o diretório temporário criado — evita deixar
  // lixo de execuções de teste espalhado no sistema de arquivos do
  // desenvolvedor/CI.
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // Preâmbulo: testa a função central do store — dado um vetor de consulta,
  // query() deve devolver os itens mais similares primeiro (maior cosine
  // similarity) e respeitar o limite `topK`.
  it("ranks the most similar vector first and respects topK", () => {
    // mkdtempSync cria uma pasta temporária única (evita colisão entre
    // execuções de teste em paralelo).
    dir = mkdtempSync(join(tmpdir(), "vector-store-test-"));
    const store = new FileVectorStore(join(dir, "store.json"));

    // Três vetores de exemplo em 3 dimensões, escolhidos para ter uma
    // ordem de similaridade óbvia em relação ao vetor de consulta [1,0,0]:
    // "a" é idêntico (similaridade 1), "c" é quase idêntico (0.9 na
    // primeira dimensão), "b" é ortogonal (similaridade 0).
    store.replaceAll([
      { item: { id: "a", title: "A", content: "" }, vector: [1, 0, 0] },
      { item: { id: "b", title: "B", content: "" }, vector: [0, 1, 0] },
      { item: { id: "c", title: "C", content: "" }, vector: [0.9, 0.1, 0] },
    ]);

    // Pede só os 2 mais similares ao vetor [1,0,0].
    const results = store.query([1, 0, 0], 2);
    // topK=2 deve limitar a exatamente 2 resultados, mesmo havendo 3 itens
    // no índice.
    expect(results).toHaveLength(2);
    // "a" (idêntico) deve vir primeiro, "c" (quase idêntico) em segundo —
    // "b" (ortogonal, menos similar) fica de fora do top 2.
    expect(results[0].item.id).toBe("a");
    expect(results[1].item.id).toBe("c");
    // O score do primeiro colocado deve ser estritamente maior que o do
    // segundo, confirmando que o resultado está de fato ordenado por
    // similaridade decrescente.
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  // Preâmbulo: confirma que dados gravados por uma instância de
  // FileVectorStore (via replaceAll, que chama persist()) são lidos
  // corretamente por uma SEGUNDA instância apontando para o mesmo arquivo —
  // valida o ciclo completo grava-no-disco / lê-do-disco usado em produção
  // (o script de ingest grava, o processo do servidor lê depois).
  it("persists across instances reading the same file", () => {
    dir = mkdtempSync(join(tmpdir(), "vector-store-test-"));
    const path = join(dir, "store.json");

    // Primeira instância: grava um único item e é descartada em seguida
    // (não é reaproveitada abaixo, de propósito, para simular processos
    // diferentes — ex.: o processo do `npm run ingest` terminando antes do
    // processo do servidor começar).
    new FileVectorStore(path).replaceAll([
      { item: { id: "a", title: "A", content: "" }, vector: [1, 0] },
    ]);

    // Segunda instância, criada do zero: seu construtor chama load()
    // internamente, então já deve enxergar o item gravado acima.
    const reloaded = new FileVectorStore(path);
    expect(reloaded.size).toBe(1);
  });
});
