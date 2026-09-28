// Adapter de canal para o Telegram Bot API. Traduz o formato de "update" do
// Telegram para InboundMessage, chama o Orchestrator, e envia a resposta de
// volta usando o método sendMessage da API do Telegram.
import type { Request, Response } from "express";
import { env } from "../config.js";
import type { InboundMessage } from "../types.js";
import type { ChannelAdapter } from "./types.js";

// Formato (parcial — só os campos que este adapter usa) de um "update" que
// o Telegram envia via webhook. O Telegram manda updates de vários tipos
// (mensagem editada, membro do grupo mudou, etc.); só nos interessa
// `message`, e dentro dele só mensagens de texto.
interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
    // Timestamp em SEGUNDOS desde epoch (padrão Unix) — diferente de
    // Date.now() do JS, que é em milissegundos; por isso é multiplicado por
    // 1000 mais abaixo ao montar o InboundMessage.
    date: number;
  };
}

// Preâmbulo: TelegramAdapter implementa ChannelAdapter para o canal
// Telegram. Só é instanciado (via createTelegramAdapter, no final do
// arquivo) se TELEGRAM_BOT_TOKEN estiver configurado no .env — caso
// contrário o canal fica desabilitado e src/server.ts nem monta a rota
// correspondente.
//
// Setup fora deste código: registre o webhook uma vez, apontando para a URL
// pública deste servidor, chamando:
//   https://api.telegram.org/bot<TOKEN>/setWebhook?url=<sua-url>/webhook/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>
export class TelegramAdapter implements ChannelAdapter {
  // Satisfaz ChannelAdapter.name — usado por server.ts para montar a rota
  // /webhook/telegram.
  readonly name = "telegram" as const;

  constructor(private readonly botToken: string, private readonly webhookSecret?: string) {}

  // Preâmbulo: handleWebhook() é chamado por src/server.ts para toda
  // requisição HTTP recebida em /webhook/telegram. Faz três coisas em
  // sequência: valida o segredo do webhook (se configurado), extrai o texto
  // da mensagem, e — se houver texto — chama o Orchestrator e envia a
  // resposta de volta via API do Telegram.
  async handleWebhook(
    req: Request,
    res: Response,
    onMessage: (msg: InboundMessage) => Promise<string>
  ): Promise<void> {
    // Se um segredo foi configurado (TELEGRAM_WEBHOOK_SECRET), o Telegram é
    // instruído (no momento do setWebhook) a incluir esse mesmo valor no
    // header abaixo em toda chamada — isso evita que qualquer pessoa na
    // internet descubra a URL do webhook e finja ser o Telegram enviando
    // mensagens falsas para o agente.
    if (this.webhookSecret) {
      const provided = req.header("X-Telegram-Bot-Api-Secret-Token");
      if (provided !== this.webhookSecret) {
        // 401 Unauthorized: rejeita sem processar nada do corpo da
        // requisição.
        res.sendStatus(401);
        return;
      }
    }

    // Faz o cast do corpo da requisição (já parseado como JSON pelo
    // middleware express.json() em server.ts) para o formato esperado.
    const update = req.body as TelegramUpdate;
    const message = update.message;

    // Responde 200 ao Telegram IMEDIATAMENTE, antes de processar a
    // mensagem — o Telegram reenvia o webhook se não receber um 200
    // rapidamente, e como a resposta do LLM pode demorar alguns segundos,
    // confirmamos o recebimento primeiro para evitar reenvios duplicados
    // do mesmo update.
    res.sendStatus(200);
    // Ignora updates sem texto (figurinha, foto, membro entrou no grupo,
    // etc.) — este agente só sabe lidar com texto.
    if (!message?.text) return;

    // O chat id do Telegram é number; convertido para string porque
    // InboundMessage.conversationId/userId são sempre string em todo o
    // pipeline (mantém o formato uniforme entre canais, já que o WhatsApp
    // usa string nativamente — o número de telefone).
    const chatId = String(message.chat.id);
    const inbound: InboundMessage = {
      channel: this.name,
      userId: chatId,
      // No Telegram, conversationId e userId são o mesmo valor porque cada
      // chat 1:1 com o bot já é uma conversa isolada por definição da
      // própria API do Telegram.
      conversationId: chatId,
      text: message.text,
      // Converte segundos (Telegram) para milissegundos (padrão interno do
      // projeto, igual ao que Date.now() produz).
      timestamp: message.date * 1000,
    };

    // Delega ao Orchestrator todo o processamento (RAG, prompt, LLM,
    // handoff, log) — este adapter não sabe nem precisa saber o que
    // acontece dentro de onMessage.
    const reply = await onMessage(inbound);
    // Envia a resposta de volta ao MESMO chat de onde a mensagem veio.
    await this.sendMessage(chatId, reply);
  }

  // Preâmbulo: sendMessage() encapsula a chamada HTTP ao método
  // sendMessage da API do Telegram. Método público (não só usado
  // internamente por handleWebhook) para permitir, se necessário, enviar
  // mensagens proativas fora do fluxo de resposta a um webhook.
  async sendMessage(chatId: string, text: string): Promise<void> {
    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    // Mesmo padrão dos outros clients HTTP do projeto: fetch só rejeita em
    // falha de rede, então checamos res.ok manualmente e só logamos o erro
    // (não lançamos) — uma falha ao ENVIAR a resposta não deveria derrubar
    // o processo nem impedir o próximo webhook de ser processado.
    if (!res.ok) {
      console.error(`Telegram sendMessage failed (${res.status}): ${await res.text().catch(() => "")}`);
    }
  }
}

// Preâmbulo: createTelegramAdapter() é a factory usada por src/server.ts
// para decidir se o canal Telegram deve ser habilitado — devolve `null`
// (em vez de lançar erro) se TELEGRAM_BOT_TOKEN não estiver configurado,
// permitindo rodar o servidor só com WhatsApp, só com Telegram, ou com os
// dois ao mesmo tempo, dependendo do que estiver no .env.
export function createTelegramAdapter(): TelegramAdapter | null {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  return new TelegramAdapter(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET);
}
