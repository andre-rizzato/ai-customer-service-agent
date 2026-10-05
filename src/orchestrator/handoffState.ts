// Estado de "conversa em atendimento humano" — a peça que faltava depois da
// revisão de segurança de 04/10/2026 (item #5): até aqui, um handoff só
// disparava uma notificação (ver handoffNotifier/) e respondia uma vez; na
// PRÓXIMA mensagem do mesmo cliente, o bot voltava a responder normalmente
// por cima do atendente humano, porque nada marcava a conversa como "já
// transferida". Esta classe guarda esse estado, por conversa, em disco —
// precisa sobreviver a um restart do processo (diferente do RateLimiter,
// que é só em memória), senão um reboot da VM no meio de um atendimento
// humano faria o bot voltar sozinho sem ninguém pedir.
//
// Atualização de 05/10/2026: a decisão de COMO o atendente responde foi
// tomada (Opção B do item #5 — relay pelo sistema, atendente no Telegram,
// ver src/handoff/relay.ts). Pra isso esta classe passou a guardar também
// o CANAL de origem da conversa (`channel`) — o relay precisa saber se a
// resposta do atendente vai pra API do Telegram, do WhatsApp, ou fica
// esperando o polling do widget web — e ganhou getState() pra quem só
// quer ler o estado sem disparar o efeito colateral do timeout.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../config.js";
import type { ChannelName } from "../types.js";

// Preâmbulo: HandoffState é o formato salvo em disco, um arquivo por
// conversa. `since` é o timestamp (epoch ms) de quando o handoff foi
// ativado (ou da última resposta do atendente — ver activate()) — é o que
// permite calcular se já passou do timeout de segurança (ver isActive()
// abaixo), sem precisar de nenhum agendador/cron rodando em paralelo: a
// checagem é feita sob demanda, na próxima mensagem que chegar.
//
// `channel` é opcional porque arquivos gravados ANTES de 05/10/2026 não têm
// esse campo — o relay trata a ausência como "não sei pra onde entregar" e
// avisa o atendente, em vez de chutar um canal.
export interface HandoffState {
  active: boolean;
  since: number;
  channel?: ChannelName;
}

// Valor usado quando o arquivo de estado ainda não existe (conversa nunca
// teve handoff) — equivalente a "nunca ativado".
const INACTIVE: HandoffState = { active: false, since: 0 };

// Preâmbulo: HandoffStateStore é instanciada uma vez pelo Orchestrator,
// com o timeout vindo de agent.config.json (agentConfig.handoffTimeoutHours
// — configurável por negócio, mesmo padrão de rateLimit/minRelevanceScore).
// Usa a MESMA pasta de CONVERSATIONS_DIR do ConversationStore, mas em uma
// subpasta própria ("handoff-state"), pra não misturar os dois tipos de
// arquivo (histórico de conversa vs. estado de handoff) no mesmo diretório.
export class HandoffStateStore {
  // Pasta onde cada conversa vira um arquivo .json próprio de estado.
  private readonly dir: string;
  // Timeout de segurança, em milissegundos — calculado a partir das horas
  // configuradas; não é mais `readonly` porque updateTimeout() (abaixo)
  // recalcula esse valor quando a tela de configuração salva um novo
  // handoffTimeoutHours, sem precisar recriar a store (o que faria
  // mkdirSync rodar de novo à toa).
  private timeoutMs: number;

  constructor(timeoutHours: number) {
    this.dir = resolve(env.CONVERSATIONS_DIR, "handoff-state");
    this.timeoutMs = timeoutHours * 60 * 60 * 1000;
    // recursive:true não falha se a pasta já existir — seguro chamar
    // sempre na inicialização, mesmo processo reiniciado.
    mkdirSync(this.dir, { recursive: true });
  }

  // Preâmbulo: updateTimeout() recalcula o timeout de segurança a partir de
  // um novo valor em horas — chamado por Orchestrator.reloadConfig() depois
  // que a tela de configuração salva um novo handoffTimeoutHours. Conversas
  // já em handoff mantêm o `since` gravado (o instante em que a transferência
  // ocorreu não muda), só o limite contra o qual isActive() compara passa a
  // ser o novo.
  updateTimeout(timeoutHours: number): void {
    this.timeoutMs = timeoutHours * 60 * 60 * 1000;
  }

  // Preâmbulo: filePathFor() calcula o caminho do arquivo de estado de uma
  // conversa específica — mesma lógica de sanitização do
  // ConversationStore.filePathFor() (conversationId pode vir de fonte
  // externa — número de telefone, chat id — e não é necessariamente um
  // nome de arquivo válido nem seguro contra path traversal).
  private filePathFor(conversationId: string): string {
    const safeId = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return resolve(this.dir, `${safeId}.json`);
  }

  // Preâmbulo: load() lê o estado salvo de uma conversa, ou devolve
  // INACTIVE se o arquivo não existe (conversa que nunca teve handoff).
  // Privado — só usado internamente por getState()/isActive()/activate()/
  // release().
  private load(conversationId: string): HandoffState {
    const path = this.filePathFor(conversationId);
    if (!existsSync(path)) return INACTIVE;
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  // Preâmbulo: save() grava o estado de uma conversa em disco — sempre
  // reescreve o arquivo inteiro (ele só tem dois campos, custo
  // desprezível), mesmo padrão de simplicidade do ConversationStore.
  private save(conversationId: string, state: HandoffState): void {
    writeFileSync(this.filePathFor(conversationId), JSON.stringify(state), "utf-8");
  }

  // Preâmbulo: getState() devolve o estado de uma conversa já com o
  // timeout aplicado (via isActive(), que libera sozinho um handoff
  // vencido) — usado pelo relay (src/handoff/relay.ts) e pelas rotas do
  // Mini App/polling do widget, que precisam saber o canal e se a conversa
  // ainda está com um humano. Devolve uma CÓPIA (spread) pra quem chamou
  // não conseguir mutar sem querer o objeto INACTIVE compartilhado.
  getState(conversationId: string): HandoffState {
    const active = this.isActive(conversationId);
    return { ...this.load(conversationId), active };
  }

  // Preâmbulo: isActive() é chamado pelo Orchestrator no INÍCIO do
  // pipeline, antes até do rate limiter — se devolver true, o Orchestrator
  // só registra a mensagem no histórico e NÃO responde nada (ver PASSO 0
  // em orchestrator.ts). Também é responsável por liberar sozinho um
  // handoff esquecido: se já passou do timeout configurado desde a
  // ativação, chama release() e devolve false, sem precisar de nenhuma
  // ação externa.
  isActive(conversationId: string): boolean {
    const state = this.load(conversationId);
    if (!state.active) return false;

    // Timeout de segurança: evita que um atendente que esqueceu de liberar
    // a conversa deixe o cliente sem resposta do bot pra sempre — depois
    // de `timeoutMs` sem ninguém chamar release() explicitamente, o bot
    // volta a responder sozinho.
    if (Date.now() - state.since >= this.timeoutMs) {
      this.release(conversationId);
      return false;
    }

    return true;
  }

  // Preâmbulo: activate() marca uma conversa como "em atendimento humano"
  // — chamada pelo Orchestrator em TODO ponto que já dispara o
  // HandoffNotifier (gatilho por palavra-chave, falha do AgentService,
  // capacidade sem conector ainda, e a nova intenção cancel_order — ver
  // orchestrator.ts), nunca diretamente por um canal/adapter.
  //
  // Também é chamada a cada resposta do atendente (via
  // Orchestrator.recordHumanReply()) pra RENOVAR `since`: o timeout de
  // segurança passa a contar a partir da última atividade humana, não do
  // momento da transferência — senão um atendimento ativo de mais de 4h
  // seria cortado no meio, com o bot voltando a falar por cima do
  // atendente. `channel` é opcional no parâmetro: quando não vem (renovação
  // pelo atendente, que não sabe nem precisa saber o canal), reaproveita o
  // que já estava gravado.
  activate(conversationId: string, channel?: ChannelName): void {
    const previous = this.load(conversationId);
    this.save(conversationId, { active: true, since: Date.now(), channel: channel ?? previous.channel });
  }

  // Preâmbulo: release() limpa o estado de handoff de uma conversa,
  // devolvendo o controle pro bot. Chamada automaticamente por isActive()
  // quando o timeout expira, e manualmente pelo script
  // scripts/releaseHandoff.ts (o mecanismo "comando explícito do
  // atendente" — ver docs/SECURITY_REVIEW.md item #5) até existir uma
  // interface de verdade pra isso. Desde 05/10/2026 também pelo botão
  // "Devolver ao bot" no Telegram/Mini App (ver src/handoff/relay.ts).
  //
  // Preserva `channel` de propósito: se o atendente responder DEPOIS da
  // liberação (ex.: lembrou de algo), o relay ainda sabe pra onde entregar
  // e reativa o handoff, em vez de falhar com "canal desconhecido".
  release(conversationId: string): void {
    const previous = this.load(conversationId);
    this.save(conversationId, { ...INACTIVE, channel: previous.channel });
  }
}
