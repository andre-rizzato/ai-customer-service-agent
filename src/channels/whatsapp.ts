// Adapter de canal para a Meta WhatsApp Cloud API (Fase 2 do runbook:
// "API oficial direta"). Traduz o formato de webhook da Meta para
// InboundMessage, chama o Orchestrator, e envia a resposta via endpoint de
// mensagens da Graph API.
import type { Request, Response } from "express";
import { env } from "../config.js";
import type { InboundMessage } from "../types.js";
import type { ChannelAdapter } from "./types.js";

// Formato (parcial) do corpo que a Meta envia em cada POST de webhook. A
// estrutura é deliberadamente aninhada (entry -> changes -> value ->
// messages) porque um único webhook pode, em teoria, carregar mudanças de
// múltiplos números de telefone e múltiplos eventos — só nos interessa o
// primeiro entry/change e as mensagens de texto dentro dele.
interface WhatsAppWebhookBody {
  entry?: {
    changes?: {
      value?: {
        messages?: {
          // Número de telefone de origem, no formato que a Meta usa
          // (sem "+", com código do país) — vira o conversationId/userId.
          from: string;
          // Timestamp em SEGUNDOS, como string (peculiaridade da API da
          // Meta) — por isso é convertido com Number(...) * 1000 mais abaixo.
          timestamp: string;
          text?: { body: string };
        }[];
      };
    }[];
  }[];
}

// Preâmbulo: WhatsAppAdapter implementa ChannelAdapter para o canal
// WhatsApp via Meta Cloud API. Só é instanciado (via createWhatsAppAdapter,
// no final do arquivo) se as três credenciais necessárias estiverem
// configuradas.
//
// Setup fora deste código: no painel do Meta for Developers, aponte o
// webhook do app para <sua-url-pública>/webhook/whatsapp — a Meta faz uma
// chamada GET de verificação antes de aceitar o webhook (ver
// handleVerification abaixo), e depois passa a enviar POSTs para cada
// mensagem recebida.
export class WhatsAppAdapter implements ChannelAdapter {
  readonly name = "whatsapp" as const;

  constructor(
    // Token de acesso à Graph API, usado para AUTENTICAR o envio de
    // mensagens (não a recepção — recepção usa o verify token abaixo).
    private readonly accessToken: string,
    // Id do número de telefone comercial configurado no Meta for
    // Developers — vai na URL do endpoint de envio de mensagens.
    private readonly phoneNumberId: string,
    // Token arbitrário definido por quem configura o app, usado só durante
    // o handshake de verificação do webhook (não é o mesmo que accessToken).
    private readonly verifyToken: string
  ) {}

  // Preâmbulo: handleWebhook() é chamado por src/server.ts para toda
  // requisição em /webhook/whatsapp, tanto GET (verificação, feita uma vez
  // pela Meta ao salvar a configuração do webhook) quanto POST (mensagens
  // reais, recorrente).
  async handleWebhook(
    req: Request,
    res: Response,
    onMessage: (msg: InboundMessage) => Promise<string>
  ): Promise<void> {
    // A Meta usa o MESMO endpoint para verificação (GET) e para entrega de
    // eventos (POST) — por isso este adapter ramifica pelo método HTTP, ao
    // contrário do TelegramAdapter (que só recebe POST).
    if (req.method === "GET") {
      this.handleVerification(req, res);
      return;
    }

    const body = req.body as WhatsAppWebhookBody;
    // Navega a estrutura aninhada até a lista de mensagens; `?? []` cobre
    // qualquer nível ausente (ex.: um webhook de "status de entrega" que
    // não tem `messages`, só `statuses`) sem lançar erro de acesso a
    // propriedade de undefined.
    const messages = body.entry?.[0]?.changes?.[0]?.value?.messages ?? [];

    // Confirma recebimento imediatamente, mesmo raciocínio do
    // TelegramAdapter: evita que a Meta reenvie o webhook por demora na
    // resposta do LLM.
    res.sendStatus(200);

    // Um único webhook pode trazer mais de uma mensagem (ex.: usuário
    // mandou várias mensagens rapidamente) — processa cada uma
    // sequencialmente, mantendo a ordem em que chegaram.
    for (const message of messages) {
      // Ignora mensagens sem corpo de texto (áudio, imagem, figurinha,
      // etc.) — mesmo critério do TelegramAdapter.
      if (!message.text?.body) continue;

      const inbound: InboundMessage = {
        channel: this.name,
        userId: message.from,
        // No WhatsApp, o próprio número de telefone já identifica a
        // conversa de forma única (não existe múltiplos "chats" com o
        // mesmo número, diferente de um app que suporte vários tópicos por
        // usuário) — por isso conversationId = userId, mesmo padrão do
        // TelegramAdapter.
        conversationId: message.from,
        text: message.text.body,
        timestamp: Number(message.timestamp) * 1000,
      };

      const reply = await onMessage(inbound);
      await this.sendMessage(message.from, reply);
    }
  }

  // Preâmbulo: handleVerification() implementa o handshake de verificação
  // exigido pela Meta antes de aceitar um webhook novo — chamado só a
  // partir de handleWebhook() quando o método é GET, nunca diretamente por
  // server.ts.
  private handleVerification(req: Request, res: Response): void {
    // A Meta manda três query params neste handshake, definidos pelo
    // protocolo do WhatsApp Cloud API (não é algo deste projeto).
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    // Só confirma a verificação se o modo for "subscribe" E o token enviado
    // pela Meta bater com o WHATSAPP_VERIFY_TOKEN configurado — isso prova
    // que quem está configurando o webhook é realmente o dono deste app no
    // Meta for Developers (o token foi definido por quem configurou,
    // igualmente, nos dois lados).
    if (mode === "subscribe" && token === this.verifyToken) {
      // Devolver o `challenge` recebido é o que a Meta exige para
      // considerar a verificação bem-sucedida.
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }

  // Preâmbulo: sendMessage() encapsula a chamada HTTP ao endpoint de envio
  // de mensagens da Graph API. Chamado por handleWebhook() para cada
  // mensagem recebida, depois que o Orchestrator devolve o texto de
  // resposta.
  async sendMessage(to: string, text: string): Promise<void> {
    const res = await fetch(`https://graph.facebook.com/v20.0/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Autenticação da Graph API é via Bearer token (accessToken), não
        // relacionada ao verifyToken usado só na verificação do webhook.
        Authorization: `Bearer ${this.accessToken}`,
      },
      // Formato exigido pela Graph API para uma mensagem de texto simples —
      // "messaging_product" e "type" são obrigatórios e fixos para este
      // caso de uso.
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    });
    // Mesmo padrão dos outros clients HTTP do projeto: loga em vez de
    // lançar, para não derrubar o processamento de outras mensagens do
    // mesmo webhook por causa de uma falha de envio isolada.
    if (!res.ok) {
      console.error(`WhatsApp sendMessage failed (${res.status}): ${await res.text().catch(() => "")}`);
    }
  }
}

// Preâmbulo: createWhatsAppAdapter() é a factory usada por src/server.ts
// para decidir se o canal WhatsApp deve ser habilitado — só instancia o
// adapter se as TRÊS credenciais necessárias estiverem presentes;
// diferente do Telegram (que só depende de um token), o WhatsApp precisa
// dos três valores para funcionar de ponta a ponta (enviar, receber e
// verificar), então exigimos todos juntos.
export function createWhatsAppAdapter(): WhatsAppAdapter | null {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_VERIFY_TOKEN) return null;
  return new WhatsAppAdapter(env.WHATSAPP_ACCESS_TOKEN, env.WHATSAPP_PHONE_NUMBER_ID, env.WHATSAPP_VERIFY_TOKEN);
}
