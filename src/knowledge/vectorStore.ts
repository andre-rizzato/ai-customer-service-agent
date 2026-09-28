// Armazenamento vetorial local, em arquivo JSON, com busca por similaridade
// de cosseno feita "na unha" (força bruta). Existe como classe própria
// (em vez de embutir a lógica dentro de KnowledgeBase) para poder ser
// testada isoladamente (ver tests/vectorStore.test.ts) e para deixar
// explícito qual seria o ponto de troca caso o catálogo cresça demais para
// uma busca linear (Pinecone, pgvector, Supabase — qualquer um implementando
// o mesmo formato load/replaceAll/query).

// existsSync/mkdirSync/readFileSync/writeFileSync: operações de arquivo
// síncronas — aceitável aqui porque o volume de dados é pequeno (o próprio
// runbook recomenda vector DB "de verdade" só acima de ~15-20 itens; até lá
// isto é rápido o bastante) e porque load/persist só rodam na inicialização
// do processo ou durante o ingest, nunca dentro do caminho quente de uma
// resposta a uma mensagem individual (query() é só leitura em memória).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
// dirname: usado para garantir que a pasta do arquivo de índice exista
// antes de tentar escrever nele (mkdirSync recursive).
import { dirname } from "node:path";
import type { KnowledgeItem, RetrievedChunk } from "../types.js";

// Formato de UM registro persistido no arquivo JSON: o item de conhecimento
// original mais o vetor de embedding calculado para ele. Guardamos o item
// inteiro (não só o id) para não precisar recarregar o catálogo original a
// cada busca — o vector store é autossuficiente.
interface StoredRecord {
  item: KnowledgeItem;
  vector: number[];
}

// Preâmbulo: cosineSimilarity calcula o cosseno do ângulo entre dois
// vetores — a métrica padrão para comparar embeddings de texto (quanto mais
// próximo de 1, mais parecido semanticamente). É uma função livre (não
// método de classe) porque é pura, sem estado, e só usada dentro deste
// arquivo. Chamada uma vez por item armazenado, a cada chamada de query().
function cosineSimilarity(a: number[], b: number[]): number {
  // Produto escalar (dot product) dos dois vetores.
  let dot = 0;
  // Norma (comprimento) ao quadrado de cada vetor — calculadas no mesmo
  // loop do produto escalar para evitar percorrer os arrays três vezes.
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  // Guarda contra divisão por zero: um vetor de norma zero (todos os
  // componentes zero) não tem direção definida, então tratamos como
  // similaridade zero em vez de deixar o resultado virar NaN.
  if (normA === 0 || normB === 0) return 0;
  // Fórmula do cosseno: produto escalar dividido pelo produto das normas.
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Preâmbulo: FileVectorStore é a classe pública deste módulo. Guarda todos
// os registros (item + vetor) em memória, carregados de um arquivo JSON na
// construção, e persiste de volta no disco sempre que replaceAll() é
// chamado. Usada tanto pelo script de ingest (grava) quanto pela
// KnowledgeBase (só lê, via query()).
export class FileVectorStore {
  // Todos os registros carregados em memória — a "busca" é simplesmente
  // iterar este array e calcular similaridade contra cada item.
  private records: StoredRecord[] = [];

  constructor(private readonly filePath: string) {
    // Carrega o conteúdo existente (se houver) assim que a instância é
    // criada, para que query() já funcione imediatamente sem uma chamada
    // extra de inicialização.
    this.load();
  }

  // Preâmbulo: load() lê o arquivo JSON do disco (se existir) e preenche
  // `this.records`. Privado — só o construtor chama.
  private load() {
    if (existsSync(this.filePath)) {
      this.records = JSON.parse(readFileSync(this.filePath, "utf-8"));
    }
    // Se o arquivo não existir ainda (primeira execução, antes do ingest),
    // `this.records` permanece o array vazio do valor inicial da
    // propriedade — KnowledgeBase detecta esse caso (size === 0) e avisa no
    // console para o operador rodar `npm run ingest`.
  }

  // Preâmbulo: persist() serializa `this.records` de volta para o arquivo
  // JSON no disco. Privado — só replaceAll() chama, depois de atualizar o
  // array em memória.
  private persist() {
    // Garante que a pasta de destino exista (ex.: "./data/") antes de
    // escrever o arquivo — recursive:true não falha se a pasta já existir.
    mkdirSync(dirname(this.filePath), { recursive: true });
    // Sobrescreve o arquivo inteiro com o conteúdo atual de `this.records`
    // — este store não faz updates incrementais, sempre substitui tudo
    // (coerente com o fluxo de ingest, que reprocessa o catálogo inteiro
    // cada vez que roda).
    writeFileSync(this.filePath, JSON.stringify(this.records), "utf-8");
  }

  // Preâmbulo: replaceAll() é o método usado pelo ingest para publicar um
  // novo índice completo, descartando qualquer conteúdo anterior. Chamado
  // uma vez por execução de `npm run ingest`.
  replaceAll(records: StoredRecord[]) {
    this.records = records;
    this.persist();
  }

  // Getter simples usado por KnowledgeBase para decidir se deve avisar o
  // operador que o índice está vazio (catálogo nunca indexado).
  get size(): number {
    return this.records.length;
  }

  // Preâmbulo: query() é o método de leitura usado em tempo de resposta —
  // recebe o vetor da pergunta do usuário (já calculado por
  // KnowledgeBase.search) e devolve os `topK` itens mais similares,
  // ordenados do mais para o menos parecido. Não aplica nenhum corte de
  // relevância mínima aqui — isso é responsabilidade de quem chama
  // (KnowledgeBase), para manter esta classe genérica (só "índice
  // vetorial", sem regra de negócio).
  query(vector: number[], topK: number): RetrievedChunk[] {
    return this.records
      // Calcula a similaridade do vetor de busca contra CADA item guardado
      // — é a parte "força bruta": O(n) na quantidade de itens do catálogo,
      // aceitável para catálogos pequenos/médios (ver comentário no topo do
      // arquivo sobre quando trocar por um vector DB de verdade).
      .map((r) => ({ item: r.item, score: cosineSimilarity(vector, r.vector) }))
      // Ordena do maior score (mais parecido) para o menor.
      .sort((a, b) => b.score - a.score)
      // Mantém só os `topK` primeiros — o resto é descartado.
      .slice(0, topK);
  }
}
