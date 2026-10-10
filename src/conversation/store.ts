// Armazena o histórico de cada conversa (para montar o prompt) e, ao mesmo
// tempo, grava um log de auditoria append-only (para revisão humana
// semanal, Fase 7 do runbook). As duas responsabilidades vivem juntas nesta
// classe porque toda escrita de histórico DEVE também virar uma linha de
// auditoria — separar em duas classes arriscaria alguém atualizar uma sem
// atualizar a outra.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env } from "../config.js";
import type { ConversationTurn } from "../types.js";

// Memória de longo prazo de uma conversa, gravada em `<id>.memory.json`
// (ver getMemory()/saveMemory() abaixo e src/conversation/memory.ts).
export interface StoredMemory {
  // Resumo acumulado dos turnos que já saíram da janela do prompt.
  summary: string;
  // Quantos turnos de diálogo da sessão atual (contados do início dela) o
  // resumo já cobre — os seguintes ainda precisam ir literalmente no prompt.
  coveredTurns: number;
  // Timestamp do primeiro turno da sessão a que este resumo pertence. Se o
  // atendimento for encerrado e começar uma sessão nova (ver
  // currentSession.ts), o primeiro turno muda e o resumo antigo deixa de
  // valer — senão o bot "lembraria" de um atendimento já encerrado, o
  // mesmo bug de 06/10 que currentSession() resolveu.
  sessionStart: number;
}

// Preâmbulo: ConversationStore é instanciada uma vez pelo Orchestrator e
// mantém, por processo, um cache em memória do histórico de cada conversa
// (para não reler o arquivo do disco a cada mensagem), além de escrever em
// disco a cada novo turno.
export class ConversationStore {
  // Pasta onde cada conversa vira um arquivo próprio (um .json por
  // conversationId) — configurável via CONVERSATIONS_DIR no .env.
  private readonly dir: string;
  // Caminho do arquivo único de auditoria, formato JSON Lines (uma linha =
  // um turno, de qualquer conversa) — configurável via AUDIT_LOG_PATH.
  private readonly auditLogPath: string;
  // Cache em memória: conversationId -> histórico já carregado, para evitar
  // reler o arquivo do disco em toda mensagem da mesma conversa.
  private readonly cache = new Map<string, ConversationTurn[]>();

  constructor() {
    // Resolve os dois caminhos configurados para absolutos.
    this.dir = resolve(env.CONVERSATIONS_DIR);
    this.auditLogPath = resolve(env.AUDIT_LOG_PATH);
    // Garante que as pastas de destino existam antes de qualquer escrita —
    // recursive:true não falha se já existirem, então é seguro chamar
    // sempre na inicialização.
    mkdirSync(this.dir, { recursive: true });
    // dirname(this.auditLogPath) porque AUDIT_LOG_PATH aponta para um
    // ARQUIVO (não uma pasta) — precisamos garantir que a pasta que CONTÉM
    // esse arquivo exista.
    mkdirSync(dirname(this.auditLogPath), { recursive: true });
  }

  // Preâmbulo: filePathFor() calcula o caminho do arquivo de histórico de
  // uma conversa específica, a partir do seu conversationId. Privado — só
  // usado internamente por getHistory()/append().
  private filePathFor(conversationId: string): string {
    // Sanitiza o conversationId para um nome de arquivo seguro: troca
    // qualquer caractere que não seja letra/número/hífen/underscore por "_".
    // Necessário porque conversationId pode vir de fontes externas (número
    // de telefone com "+", chat id do Telegram) que não são
    // necessariamente nomes de arquivo válidos em todo sistema operacional,
    // e também evita um ataque de path traversal (ex.: conversationId
    // contendo "../../etc/passwd").
    const safeId = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return resolve(this.dir, `${safeId}.json`);
  }

  // Preâmbulo: getMemory()/saveMemory() leem e gravam a memória de longo
  // prazo de uma conversa (resumo dos turnos que saíram da janela do prompt
  // — ver src/conversation/memory.ts) num arquivo ao lado do histórico,
  // `<id>.memory.json`. Arquivo separado (e não um turno no histórico)
  // porque o resumo é reescrito a cada atualização, enquanto o histórico é
  // append-only por contrato (o cursor do polling do widget depende disso,
  // ver getHumanRepliesSince() no Orchestrator). Sem cache em memória: só é
  // lido uma vez por resposta do LLM, e é um arquivo de poucos KB.
  getMemory(conversationId: string): StoredMemory | undefined {
    const path = this.memoryPathFor(conversationId);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as StoredMemory;
    } catch {
      // Arquivo corrompido: trata como "sem resumo". O pior efeito é o
      // resumo ser refeito a partir dos turnos antigos — melhor do que
      // derrubar a resposta ao cliente.
      return undefined;
    }
  }

  saveMemory(conversationId: string, memory: StoredMemory): void {
    writeFileSync(this.memoryPathFor(conversationId), JSON.stringify(memory, null, 2), "utf-8");
  }

  // Mesma sanitização de filePathFor(), com outro sufixo.
  private memoryPathFor(conversationId: string): string {
    return this.filePathFor(conversationId).replace(/\.json$/, ".memory.json");
  }

  // Preâmbulo: exists() diz se uma conversa já tem histórico (no cache ou
  // em disco) SEM carregá-la nem criar entrada no cache. Existe por causa do
  // endpoint público de polling do widget (GET /webhook/web/poll, ver
  // src/server.ts): qualquer um na internet pode chamá-lo com um sessionId
  // inventado, e se ele usasse getHistory() direto, cada id inventado
  // viraria uma entrada nova (vazia) no `cache` — um jeito trivial de
  // inflar a memória do processo numa VM de 892MB. Checando exists()
  // antes, id desconhecido custa só um existsSync.
  exists(conversationId: string): boolean {
    return this.cache.has(conversationId) || existsSync(this.filePathFor(conversationId));
  }

  // Preâmbulo: getHistory() devolve o array de turnos de uma conversa,
  // carregando do disco na primeira vez e servindo do cache em memória nas
  // chamadas seguintes. Chamado pelo Orchestrator tanto para montar o
  // histórico enviado ao LLM quanto (indiretamente, via append) para
  // anexar ao payload de handoff.
  getHistory(conversationId: string): ConversationTurn[] {
    // Cache hit: já temos este histórico em memória, nem precisa tocar no
    // disco.
    if (this.cache.has(conversationId)) return this.cache.get(conversationId)!;

    const path = this.filePathFor(conversationId);
    // Se o arquivo já existe (conversa antiga, processo reiniciado), lê e
    // faz parse; se não existe (conversa nova), começa com array vazio.
    const history: ConversationTurn[] = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf-8"))
      : [];
    // Popula o cache para as próximas chamadas desta mesma conversa dentro
    // da vida do processo.
    this.cache.set(conversationId, history);
    return history;
  }

  // Preâmbulo: append() adiciona um novo turno ao histórico de uma
  // conversa E grava uma linha correspondente no log de auditoria — as duas
  // escritas acontecem sempre juntas, nunca uma sem a outra (ver
  // comentário no topo do arquivo). Chamado pelo Orchestrator toda vez que
  // uma mensagem do usuário chega, que um handoff dispara, ou que o LLM
  // responde.
  append(conversationId: string, turn: ConversationTurn) {
    // Garante que o histórico esteja carregado (do cache ou do disco) antes
    // de adicionar o novo turno.
    const history = this.getHistory(conversationId);
    history.push(turn);
    // Reescreve o arquivo da conversa INTEIRO com o histórico atualizado —
    // aceitável porque o histórico de uma conversa de atendimento é
    // pequeno (dezenas de turnos, não milhares); `null, 2` formata com
    // indentação para facilitar leitura manual durante debug/auditoria.
    writeFileSync(this.filePathFor(conversationId), JSON.stringify(history, null, 2), "utf-8");

    // Além de atualizar o arquivo da conversa, ACRESCENTA (não sobrescreve)
    // uma linha no log de auditoria global — appendFileSync é O(1) em
    // relação ao tamanho do arquivo existente, diferente de reescrever tudo
    // como fizemos acima para o histórico por conversa.
    appendFileSync(
      this.auditLogPath,
      // JSON Lines: um objeto JSON completo por linha, incluindo o
      // conversationId (que não faz parte de ConversationTurn) para que
      // quem ler o log saiba a qual conversa cada linha pertence, já que o
      // log mistura turnos de conversas diferentes na ordem em que
      // aconteceram.
      JSON.stringify({ conversationId, ...turn }) + "\n",
      "utf-8"
    );
  }
}
