// Contrato comum a todo canal de mensageria suportado — é a peça central da
// "genericidade" pedida: para adicionar um novo canal (Instagram, SMS,
// webchat de verdade, etc.) basta implementar esta interface, sem tocar em
// nenhuma linha do Orchestrator nem dos outros adapters.
import type { Request, Response } from "express";
import type { ChannelName, InboundMessage } from "../types.js";

export interface ChannelAdapter {
  // Nome do canal — usado por src/server.ts para montar a rota HTTP deste
  // adapter em /webhook/:name (ex.: "telegram" -> /webhook/telegram).
  readonly name: ChannelName;
  // Recebe a requisição HTTP crua da plataforma (`req`/`res` do Express) e
  // é responsável por: (1) qualquer verificação própria do canal (ex.:
  // handshake de verificação do WhatsApp, token secreto do Telegram);
  // (2) traduzir o payload específico da plataforma em um ou mais
  // InboundMessage; (3) chamar `onMessage` para cada mensagem e enviar a
  // resposta de volta pelo mecanismo de envio daquele canal; (4) responder
  // ao próprio `res` do jeito que a plataforma exige (ex.: 200 imediato
  // para o Telegram não reenviar o webhook).
  handleWebhook(req: Request, res: Response, onMessage: (msg: InboundMessage) => Promise<string>): Promise<void>;
}
