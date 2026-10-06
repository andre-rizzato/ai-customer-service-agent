// Relay de handoff — a "Opção B" do item #5 de docs/SECURITY_REVIEW.md,
// decidida e construída em 05/10/2026: o atendente humano responde de um
// lugar só (hoje, o Telegram — reply direto no alerta, ou o Mini App) e o
// sistema entrega essa resposta NA MESMA conversa em que o cliente já
// estava (widget do site, WhatsApp ou Telegram). O cliente não percebe troca
// de canal.
//
// Esta classe é a parte agnóstica de interface: não sabe se a resposta veio
// de um reply no Telegram ou de um POST do Mini App (quem sabe disso são
// src/handoff/telegramDesk.ts e as rotas /api/handoff/* em server.ts).
// Ela só sabe "entregar texto do atendente na conversa X" e "devolver a
// conversa X ao bot".
import type { ChannelName } from "../types.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { HandoffCloseReason } from "../handoffNotifier/types.js";

// Função que envia um texto pra uma conversa num canal específico,
// devolvendo se a plataforma aceitou. É exatamente a assinatura de
// TelegramAdapter.sendMessage / WhatsAppAdapter.sendMessage — server.ts
// passa esses métodos aqui. Inversão de controle de propósito: o relay não
// importa os adapters (que por sua vez precisam do relay pra repassar
// mensagens de atendente — import circular).
export type ChannelSender = (conversationId: string, text: string) => Promise<boolean>;

// Resultado de uma tentativa de relay — devolvido em vez de lançar exceção
// porque toda falha aqui é "esperada" (conversa desconhecida, canal
// desligado, API fora) e precisa virar uma mensagem legível pro atendente,
// não um stack trace no log.
export type RelayResult =
  | { ok: true; channel: ChannelName; reactivated: boolean }
  | { ok: false; error: string };

// Limite de tamanho de uma resposta do atendente. Telegram e WhatsApp
// recusam mensagens de texto acima de 4096 caracteres; o canal web não tem
// limite técnico, mas aplicar o mesmo valor pra todos evita um atendente
// descobrir o limite só quando um cliente de WhatsApp não recebe a resposta.
export const MAX_REPLY_LENGTH = 4000;

// Preâmbulo: HumanRelay é instanciado uma vez em src/server.ts, depois do
// Orchestrator e dos adapters, recebendo um "sender" por canal habilitado.
// O canal "web" não tem sender de propósito: não há como o servidor
// empurrar uma mensagem pro navegador (o canal é request/response) — a
// resposta só é gravada no histórico, e o widget a busca sozinho via
// polling (GET /webhook/web/poll, ver Orchestrator.getHumanRepliesSince).
export class HumanRelay {
  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly senders: Partial<Record<ChannelName, ChannelSender>>
  ) {}

  // Preâmbulo: reply() entrega um texto do atendente na conversa. Ordem
  // importa: PRIMEIRO envia ao canal, SÓ DEPOIS grava no histórico — se o
  // envio falhar (ex.: janela de 24h do WhatsApp fechada, API do Telegram
  // fora), o histórico não fica com uma fala que o cliente nunca recebeu, e
  // o atendente é avisado pra tentar de novo/por outro meio.
  async reply(conversationId: string, rawText: string): Promise<RelayResult> {
    const text = rawText.trim();
    if (!text) return { ok: false, error: "Mensagem vazia." };
    if (text.length > MAX_REPLY_LENGTH) {
      return { ok: false, error: `Mensagem longa demais (${text.length} caracteres, máximo ${MAX_REPLY_LENGTH}).` };
    }

    const state = this.orchestrator.getHandoffState(conversationId);
    // Sem canal gravado = conversa que nunca teve handoff (id errado) ou
    // handoff gravado antes de o estado guardar o canal (arquivos
    // anteriores a 05/10/2026). Nos dois casos não dá pra saber pra onde
    // entregar — recusa em vez de chutar.
    if (!state.channel) {
      return { ok: false, error: "Conversa desconhecida (sem handoff registrado) — não sei em qual canal entregar." };
    }

    if (state.channel !== "web") {
      const send = this.senders[state.channel];
      if (!send) return { ok: false, error: `Canal ${state.channel} não está habilitado neste servidor.` };
      // WhatsApp: a Cloud API só aceita mensagem de texto livre dentro de
      // 24h desde a última mensagem do CLIENTE. Dentro de um handoff (timeout
      // padrão de 4h, renovado a cada resposta) isso quase sempre é verdade;
      // fora disso o envio falha e cai no `ok: false` abaixo.
      const delivered = await send(conversationId, text);
      if (!delivered) return { ok: false, error: `Falha ao entregar no ${state.channel} — veja o log do servidor.` };
    }

    // Grava + renova o handoff (ver Orchestrator.recordHumanReply). No canal
    // web é ESTA linha que "entrega" a mensagem: o próximo poll do widget a
    // encontra no histórico.
    this.orchestrator.recordHumanReply(conversationId, text);
    return { ok: true, channel: state.channel, reactivated: !state.active };
  }

  // Preâmbulo: release() devolve a conversa ao bot — chamado pelo botão
  // "Devolver ao bot" (Telegram) e pelo Mini App. Recusa id desconhecido
  // pra não criar arquivo de estado/histórico por engano.
  release(conversationId: string): RelayResult {
    const state = this.orchestrator.getHandoffState(conversationId);
    if (!state.channel) return { ok: false, error: "Conversa desconhecida." };
    this.orchestrator.releaseHandoff(conversationId);
    return { ok: true, channel: state.channel, reactivated: false };
  }

  // Preâmbulo: close() ENCERRA o atendimento humano (05/10/2026) — diferente
  // de release(), avisa o cliente que o atendimento terminou. Chamado pelo
  // botão "✅ Encerrar atendimento" / comando /encerrar (TelegramDesk), pelo
  // Mini App, e pela varredura de inatividade (closeInactive, abaixo).
  //
  // Ordem: entrega o aviso -> devolve ao bot -> avisa os atendentes. O
  // handoff é liberado MESMO se a entrega do aviso falhar (ex.: janela de
  // 24h do WhatsApp fechada): o objetivo principal é não deixar o
  // atendimento pendurado — um aviso que não chegou é menos grave do que
  // uma conversa que nunca fecha. `delivered` no resultado conta o que houve.
  async close(conversationId: string, reason: HandoffCloseReason): Promise<RelayResult & { delivered?: boolean }> {
    const state = this.orchestrator.getHandoffState(conversationId);
    if (!state.channel) return { ok: false, error: "Conversa desconhecida." };
    if (!state.active) return { ok: false, error: "Este atendimento já estava encerrado." };

    const text = CLOSING_MESSAGES[reason];
    let delivered = true;
    if (state.channel !== "web") {
      const send = this.senders[state.channel];
      delivered = send ? await send(conversationId, text) : false;
    }
    // No web a gravação É a entrega (o widget pega pelo polling — o turno vai
    // marcado `relayed`). Nos outros canais grava pra auditoria e pro bot
    // saber, quando voltar, que o atendimento anterior foi encerrado.
    this.orchestrator.recordRelayedNotice(conversationId, text);
    // `true` = ponto de corte do contexto (06/10/2026): depois de encerrar, a
    // próxima mensagem do cliente é uma conversa NOVA pro LLM e pro alerta —
    // ver src/conversation/currentSession.ts.
    this.orchestrator.releaseHandoff(
      conversationId,
      reason === "inactivity" ? "Atendimento encerrado por inatividade" : "Atendimento encerrado pelo atendente",
      true
    );
    await this.orchestrator.notifyHandoffClosed(conversationId, state.channel, reason);
    return { ok: true, channel: state.channel, reactivated: false, delivered };
  }

  // Preâmbulo: closeInactive() encerra todo atendimento sem NENHUMA mensagem
  // (cliente ou atendente) há `inactivityMinutes`. Chamado a cada minuto por
  // um setInterval em src/server.ts — a checagem "sob demanda" usada no
  // timeout de handoffTimeoutHours não serve aqui, porque inatividade é
  // justamente a ausência de mensagens que disparariam a checagem.
  // `inactivityMinutes` <= 0 desliga. `nowMs` é parâmetro pra teste.
  // Devolve os ids encerrados (útil pro log e pros testes).
  async closeInactive(inactivityMinutes: number, nowMs: number = Date.now()): Promise<string[]> {
    if (inactivityMinutes <= 0) return [];
    const limitMs = inactivityMinutes * 60 * 1000;
    const closed: string[] = [];
    for (const state of this.orchestrator.listActiveHandoffs()) {
      // Arquivos anteriores a lastActivity: usa `since` (melhor estimativa).
      const lastActivity = state.lastActivity ?? state.since;
      if (!state.conversationId || nowMs - lastActivity < limitMs) continue;
      const result = await this.close(state.conversationId, "inactivity");
      if (result.ok) closed.push(state.conversationId);
    }
    return closed;
  }
}

// Mensagens automáticas de encerramento enviadas ao cliente. Constantes
// (e não config) por enquanto: ainda não houve pedido de personalizar por
// negócio — se houver, viram campos de agent.config.json como
// handoffKeywords. Terminam convidando o cliente a escrever de novo porque,
// depois do encerramento, o BOT volta a responder.
const CLOSING_MESSAGES: Record<HandoffCloseReason, string> = {
  attendant: "Atendimento encerrado. Obrigado pelo contato! Se precisar de mais alguma coisa, é só mandar uma nova mensagem.",
  inactivity:
    "Encerramos este atendimento por falta de interação. Se ainda precisar de ajuda, é só mandar uma nova mensagem.",
};
