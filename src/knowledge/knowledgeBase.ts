// Fachada de "busca na base de conhecimento" usada pelo Orchestrator — une
// o vector store (armazenamento + similaridade) com o provider de
// embeddings (transformar a pergunta do usuário em vetor) e aplica a
// "regra de vazio" da Fase 3 do runbook (descartar trechos pouco
// relevantes em vez de forçar o LLM a usar algo que não é realmente sobre
// a pergunta feita).
import { resolve } from "node:path";
import { agentConfig } from "../config.js";
import { createEmbeddingProvider } from "../embeddings/index.js";
import { FileVectorStore } from "./vectorStore.js";
import type { RetrievedChunk } from "../types.js";

// Preâmbulo: KnowledgeBase é instanciada uma vez pelo Orchestrator
// (src/orchestrator/orchestrator.ts) e reaproveitada para todas as
// mensagens que chegam depois — carregar o índice do disco e preparar o
// embedder de query só uma vez por processo, não a cada mensagem.
export class KnowledgeBase {
  // Índice vetorial carregado do disco (ver vectorStore.ts) — mesma
  // instância viva durante toda a vida do processo.
  private readonly store: FileVectorStore;
  // Provider de embeddings especializado em "query" (pergunta do usuário),
  // distinto do provider "document" usado pelo script de ingest — mesma
  // explicação do porquê em src/knowledge/ingest.ts.
  private readonly queryEmbedder = createEmbeddingProvider("query");

  constructor() {
    // Resolve o caminho configurado (agentConfig.vectorStorePath) para
    // absoluto e carrega o índice.
    this.store = new FileVectorStore(resolve(agentConfig.vectorStorePath));
    // Se o índice estiver vazio, é quase certo que o operador esqueceu de
    // rodar `npm run ingest` (ou ainda não configurou nenhum catálogo) —
    // avisamos no console em vez de falhar, porque o agente ainda pode
    // funcionar (só que sempre vai cair na "regra de vazio" abaixo e nunca
    // vai encontrar contexto para nenhuma pergunta).
    if (this.store.size === 0) {
      console.warn(
        `Vector store at ${agentConfig.vectorStorePath} is empty. Run "npm run ingest" after configuring your catalog.`
      );
    }
  }

  // Preâmbulo: search() é o método público chamado pelo Orchestrator uma
  // vez por mensagem do usuário (depois de confirmar que não é um gatilho
  // de handoff) para recuperar os trechos relevantes do catálogo antes de
  // montar o prompt.
  async search(query: string): Promise<RetrievedChunk[]> {
    // Transforma o texto da pergunta em vetor — embed() aceita uma lista e
    // devolve uma lista, então passamos um array de um elemento e
    // desestruturamos o único resultado de volta.
    const [vector] = await this.queryEmbedder.embed([query]);
    return this.store
      // Busca os `topK` itens mais similares no índice (configurado em
      // agent.config.json).
      .query(vector, agentConfig.topK)
      // "Regra de vazio": descarta qualquer resultado cuja similaridade
      // fique abaixo do corte configurado (minRelevanceScore) — evita que
      // um item "meio parecido" mas na verdade irrelevante seja injetado no
      // prompt e induza o LLM a responder algo relacionado ao item errado
      // em vez de admitir que não sabe.
      .filter((chunk) => chunk.score >= agentConfig.minRelevanceScore);
  }
}
