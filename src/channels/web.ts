// Adapter de canal "genérico" via REST simples — não representa nenhuma
// plataforma de mensageria real, existe para (a) testar o agente localmente
// sem precisar configurar Telegram/WhatsApp, e (b) servir de ponto de
// integração caso alguém queira plugar um widget de chat no próprio site.
// Também demonstra o "caso mínimo" de um ChannelAdapter, útil como
// referência para quem for implementar um canal novo.
import type { Request, Response } from "express";
import type { InboundMessage } from "../types.js";
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
    // Extrai os dois campos esperados do corpo da requisição (já parseado
    // como JSON pelo middleware express.json() em server.ts).
    const { conversationId, text } = req.body as { conversationId?: string; text?: string };

    // Validação mínima de entrada: sem os dois campos não há como montar um
    // InboundMessage válido — devolve 400 Bad Request com uma mensagem
    // explicando o que falta, em vez de deixar o restante do código falhar
    // com um erro menos claro mais adiante.
    if (!conversationId || !text) {
      res.status(400).json({ error: "conversationId and text are required" });
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
    };

    // Delega ao Orchestrator e devolve a resposta diretamente como JSON na
    // MESMA requisição HTTP — diferente de Telegram/WhatsApp, que respondem
    // 200 imediatamente e enviam a resposta de forma assíncrona por uma
    // chamada HTTP separada à API da plataforma.
    const reply = await onMessage(inbound);
    res.json({ reply });
  }
}
