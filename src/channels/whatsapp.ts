// Adapter de canal para a Meta WhatsApp Cloud API (Fase 2 do runbook:
// "API oficial direta"). Traduz o formato de webhook da Meta para
// InboundMessage, chama o Orchestrator, e envia a resposta via endpoint de
// mensagens da Graph API.
//
// Revisão de segurança de 04/10/2026 (docs/SECURITY_REVIEW.md) acrescentou
// duas camadas que não existiam antes: validação de assinatura HMAC em
// cada POST (item #3 — o WHATSAPP_VERIFY_TOKEN sozinho só protegia o
// handshake único de registro do webhook, nunca cada mensagem individual)
// e deduplicação por id de mensagem (item #1 — a Meta pode reentregar o
// mesmo webhook mais de uma vez).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../config.js";
import type { InboundMessage } from "../types.js";
import type { ChannelAdapter } from "./types.js";
import { DedupeCache } from "../orchestrator/dedupeCache.js";

// 10 minutos: generoso o bastante pra cobrir qualquer janela de reenvio
// real da Meta, sem guardar id de mensagem em memória por mais tempo do
// que o necessário — ver DedupeCache para o raciocínio completo.
const DEDUPE_TTL_MS = 10 * 60 * 1000;

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
          // Identificador único da mensagem (o "wamid") — gerado pela
          // Meta, estável entre reentregas do MESMO evento. É a chave
          // usada pelo DedupeCache (ver handleWebhook abaixo) pra
          // detectar quando a Meta está reenviando algo que já processamos.
          id: string;
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
// no final do arquivo) se as credenciais necessárias estiverem configuradas.
//
// Setup fora deste código: no painel do Meta for Developers, aponte o
// webhook do app para <sua-url-pública>/webhook/whatsapp — a Meta faz uma
// chamada GET de verificação antes de aceitar o webhook (ver
// handleVerification abaixo), e depois passa a enviar POSTs para cada
// mensagem recebida.
export class WhatsAppAdapter implements ChannelAdapter {
  readonly name = "whatsapp" as const;

  // Instância própria de DedupeCache — cada adapter (WhatsApp, Telegram)
  // guarda seus próprios ids vistos, sem risco de colisão entre os dois
  // formatos de id (wamid vs. update_id numérico), então não há motivo
  // pra compartilhar uma instância única entre canais diferentes.
  private readonly dedupe = new DedupeCache(DEDUPE_TTL_MS);

  constructor(
    // Token de acesso à Graph API, usado para AUTENTICAR o envio de
    // mensagens (não a recepção — recepção usa o app secret abaixo).
    private readonly accessToken: string,
    // Id do número de telefone comercial configurado no Meta for
    // Developers — vai na URL do endpoint de envio de mensagens.
    private readonly phoneNumberId: string,
    // Token arbitrário definido por quem configura o app, usado só durante
    // o handshake de verificação do webhook (não é o mesmo que accessToken
    // nem que appSecret).
    private readonly verifyToken: string,
    // "App Secret" do app no Meta for Developers — usado para validar a
    // assinatura HMAC-SHA256 de CADA POST recebido (ver verifySignature
    // abaixo). Diferente de verifyToken: este protege toda mensagem
    // individual, não só o handshake inicial.
    private readonly appSecret: string
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

    // Valida a assinatura ANTES de confiar em qualquer byte do corpo —
    // diferente do resto do pipeline (que responde 200 rápido e processa
    // depois), uma assinatura inválida precisa interromper tudo aqui,
    // porque não temos nenhuma garantia de que o payload veio da Meta.
    if (!this.verifySignature(req)) {
      console.error("WhatsApp webhook: assinatura inválida, requisição rejeitada.");
      res.sendStatus(401);
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
    // resposta do LLM. A deduplicação abaixo cobre o caso de a Meta
    // reenviar mesmo assim (por qualquer outro motivo de rede do lado dela).
    res.sendStatus(200);

    // Um único webhook pode trazer mais de uma mensagem (ex.: usuário
    // mandou várias mensagens rapidamente) — processa cada uma
    // sequencialmente, mantendo a ordem em que chegaram.
    for (const message of messages) {
      // Ignora mensagens sem corpo de texto (áudio, imagem, figurinha,
      // etc.) — mesmo critério do TelegramAdapter.
      if (!message.text?.body) continue;

      // Deduplicação: se já vimos este wamid dentro da janela de TTL,
      // isto é uma reentrega da Meta — pula sem chamar o Orchestrator de
      // novo (evita resposta duplicada pro cliente e custo de API em dobro).
      if (this.dedupe.hasSeenAndRecord(message.id)) {
        console.warn(`WhatsApp: mensagem ${message.id} já processada, ignorando reentrega.`);
        continue;
      }

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
      // Reply vazio é o sinal do Orchestrator pra "não responda nada" —
      // acontece quando a conversa está em handoff ativo (bot silenciado,
      // ver src/orchestrator/handoffState.ts, item #5 da revisão de
      // segurança) e também no caso de rate limit (ver orchestrator.ts).
      // Sem este if, mandaríamos uma mensagem vazia pro cliente real.
      if (reply) await this.sendMessage(message.from, reply);
    }
  }

  // Preâmbulo: verifySignature() calcula o HMAC-SHA256 dos bytes BRUTOS do
  // corpo da requisição (req.rawBody, capturado pelo hook `verify` do
  // express.json() em src/server.ts) usando o appSecret como chave, e
  // compara com o valor que a Meta manda no header
  // X-Hub-Signature-256 (formato "sha256=<hex>"). Só chamada a partir de
  // handleWebhook(), antes de qualquer processamento do corpo.
  private verifySignature(req: Request): boolean {
    const header = req.header("X-Hub-Signature-256");
    // Sem header nenhum, ou sem o corpo bruto capturado (não deveria
    // acontecer — server.ts sempre captura rawBody — mas defensivo contra
    // uma mudança futura que remova esse hook sem querer): rejeita.
    if (!header || !req.rawBody) return false;

    // O header vem como "sha256=<hex>" — separa o prefixo do hash em si.
    const [scheme, receivedHex] = header.split("=");
    if (scheme !== "sha256" || !receivedHex) return false;

    // Recalcula o HMAC esperado sobre os mesmos bytes que a Meta assinou.
    const expectedHex = createHmac("sha256", this.appSecret).update(req.rawBody).digest("hex");

    // timingSafeEqual em vez de comparação direta (===) — evita um ataque
    // de timing onde alguém descobriria o hash correto byte a byte
    // medindo quanto tempo cada comparação errada leva. Exige buffers do
    // MESMO tamanho, por isso o try/catch: tamanhos diferentes já são
    // prova de assinatura inválida, não um erro de programação.
    try {
      return timingSafeEqual(Buffer.from(receivedHex, "hex"), Buffer.from(expectedHex, "hex"));
    } catch {
      return false;
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
  // resposta (só quando esse texto não é vazio — ver handleWebhook) — e,
  // desde 05/10/2026, pelo relay de handoff (src/handoff/relay.ts) pra
  // entregar a resposta de um atendente humano. Devolve se a Graph API
  // aceitou (antes era void) pro relay não confirmar ao atendente uma
  // entrega que falhou — o caso típico é a janela de 24h do WhatsApp já ter
  // fechado.
  async sendMessage(to: string, text: string): Promise<boolean> {
    const res = await fetch(`https://graph.facebook.com/v20.0/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Autenticação da Graph API é via Bearer token (accessToken), não
        // relacionada ao appSecret/verifyToken usados só na recepção.
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
    return res.ok;
  }
}

// Preâmbulo: createWhatsAppAdapter() é a factory usada por src/server.ts
// para decidir se o canal WhatsApp deve ser habilitado — só instancia o
// adapter se TODAS as credenciais necessárias estiverem presentes.
// appSecret entrou nessa lista na revisão de segurança de 04/10/2026 —
// antes disso o canal podia subir sem validação de assinatura nenhuma; a
// checagem cruzada em src/config.ts já impede o processo de nem chegar
// aqui sem WHATSAPP_APP_SECRET configurado quando o access token está
// presente, mas o `!env.WHATSAPP_APP_SECRET` abaixo também é checado
// porque este factory é a última linha de defesa antes de criar o adapter.
export function createWhatsAppAdapter(): WhatsAppAdapter | null {
  if (
    !env.WHATSAPP_ACCESS_TOKEN ||
    !env.WHATSAPP_PHONE_NUMBER_ID ||
    !env.WHATSAPP_VERIFY_TOKEN ||
    !env.WHATSAPP_APP_SECRET
  )
    return null;
  return new WhatsAppAdapter(
    env.WHATSAPP_ACCESS_TOKEN,
    env.WHATSAPP_PHONE_NUMBER_ID,
    env.WHATSAPP_VERIFY_TOKEN,
    env.WHATSAPP_APP_SECRET
  );
}
