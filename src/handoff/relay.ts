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
}
