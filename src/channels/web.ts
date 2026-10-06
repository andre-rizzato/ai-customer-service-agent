// Adapter de canal "genérico" via REST simples — não representa nenhuma
// plataforma de mensageria real, existe para (a) testar o agente localmente
// sem precisar configurar Telegram/WhatsApp, e (b) servir de ponto de
// integração caso alguém queira plugar um widget de chat no próprio site.
// Também demonstra o "caso mínimo" de um ChannelAdapter, útil como
// referência para quem for implementar um canal novo.
import type { Request, Response } from "express";
import type { InboundMessage } from "../types.js";
import { normalizeLanguage } from "../orchestrator/messages.js";
import type { ChannelAdapter } from "./types.js";

// Preâmbulo: WebAdapter implementa ChannelAdapter respondendo de forma
// síncrona (dentro da mesma requisição HTTP) com o texto da resposta, ao
// invés de "receber e responder depois" como fazem Telegram/WhatsApp (que
// têm um passo de "enviar mensagem" separado da confirmação do webhook).
// Sempre habilitado — src/server.ts instancia este adapter incondicionalmente,
// sem depender de nenhuma variável de ambiente.
export class WebAdapter implements ChannelAdapter {
  readonly name = "web" as const;

  // Preâmbulo: handleWebhook() é chamado por src/server.ts para toda
  // requisição em /webhook/web. Espera um corpo JSON com conversationId e
  // text, e devolve a resposta do agente diretamente no corpo da resposta
  // HTTP — formato pensado para ser fácil de testar com curl/Postman ou
  // consumir de um frontend simples.
  async handleWebhook(
    req: Request,
    res: Response,
    onMessage: (msg: InboundMessage) => Promise<string>
  ): Promise<void> {
    // Extrai os campos do corpo da requisição (já parseado como JSON pelo
    // middleware express.json() em server.ts). Aceita DOIS contratos no
    // mesmo endpoint: o nosso original ({conversationId, text} — usado por
    // public/whatsapp.html) e o do widget embarcável do DistributedOrderSystem
    // ({sessionId, message} — o mesmo payload que o chat-widget.min.js já
    // manda pra API da ChatbotService em C#), pra reaproveitar aquele widget
    // sem precisar editar o JS dele (ver docs/artifacts/widget-embarcavel.html,
    // Fase 3). Os dois pares são conceitualmente a mesma coisa: id da
    // conversa + texto da mensagem.
    // `language`/`locale` (06/10/2026): idioma da página de onde o widget
    // fala (pt/en/it) — o widget do site manda `language`, o whatsapp.html
    // manda o idioma do navegador. Opcional: sem ele, o LLM responde no
    // idioma em que o cliente escreveu (ver promptBuilder.ts).
    const body = req.body as {
      conversationId?: string;
      text?: string;
      sessionId?: string;
      message?: string;
      language?: string;
      locale?: string;
    };
    const conversationId = body.conversationId ?? body.sessionId;
    const text = body.text ?? body.message;

    // Validação mínima de entrada: sem os dois campos não há como montar um
    // InboundMessage válido — devolve 400 Bad Request com uma mensagem
    // explicando o que falta, em vez de deixar o restante do código falhar
    // com um erro menos claro mais adiante.
    if (!conversationId || !text) {
      res.status(400).json({ error: "conversationId/sessionId and text/message are required" });
      return;
    }

    const inbound: InboundMessage = {
      channel: this.name,
      // Neste adapter, quem chama escolhe livremente o conversationId (não
      // há noção de "número de telefone" ou "chat id" imposta por uma
      // plataforma externa) — por isso userId e conversationId são
      // simplesmente o mesmo valor recebido no corpo da requisição.
      userId: conversationId,
      conversationId,
      text,
      timestamp: Date.now(),
      language: normalizeLanguage(body.language ?? body.locale),
    };

    // Delega ao Orchestrator e devolve a resposta diretamente como JSON na
    // MESMA requisição HTTP — diferente de Telegram/WhatsApp, que respondem
    // 200 imediatamente e enviam a resposta de forma assíncrona por uma
    // chamada HTTP separada à API da plataforma.
    const reply = await onMessage(inbound);
    // `message` é alias de `reply` pelo mesmo motivo do parsing acima — o
    // chat-widget.min.js do DistributedOrderSystem lê `response.message`
    // (ou `.response`), não `.reply`; devolver os dois nomes evita ter que
    // editar o JS do widget pra apontá-lo pra cá.
    res.json({ reply, message: reply });
  }
}
