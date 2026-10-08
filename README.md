# Agente de Atendimento IA (multi-canal)

Implementação genérica do runbook "Agente de atendimento por IA no WhatsApp,
do zero à produção" — mesma arquitetura (RAG + regras fixas + handoff), mas
com o canal desacoplado: hoje suporta **Telegram**, **WhatsApp** (Meta Cloud
API) e um adapter **web** simples para testes locais, e novos canais entram
implementando uma única interface.

## Arquitetura

```
Mensagem chega (Telegram/WhatsApp/web)
        │
        ▼
Channel adapter normaliza -> InboundMessage
        │
        ▼
Orchestrator:
  1. Rate limit por conversa
  2. Gatilho de handoff (palavra-chave / frustração) — roda ANTES do LLM
        ├─ Sim → notifica humano com histórico anexado, responde "vou te conectar"
        └─ Não → continua
  3. Busca na base de conhecimento (RAG, embeddings + cosine similarity)
  4. Monta o system prompt (3 regras fixas: só contexto, transparência, handoff)
  5. Chama o LLM (Claude ou OpenAI, plugável)
  6. Loga o turno (histórico + audit log JSONL)
        │
        ▼
Channel adapter envia a resposta de volta
```

Cada peça é uma interface plugável:

| Peça | Interface | Implementações prontas |
|---|---|---|
| Canal | `ChannelAdapter` (`src/channels/types.ts`) | Telegram, WhatsApp Cloud API, Web (REST simples) |
| LLM | `LLMProvider` (`src/llm/types.ts`) | Anthropic (Claude), OpenAI |
| Embeddings | `EmbeddingProvider` (`src/embeddings/types.ts`) | Voyage AI (padrão), OpenAI, local (sem API key) |
| Base vetorial | `FileVectorStore` (`src/knowledge/vectorStore.ts`) | Arquivo JSON local (cosine similarity) — troque por Pinecone/pgvector se o catálogo crescer muito |
| Notificação de handoff | `HandoffNotifier` (`src/handoffNotifier/types.ts`) | Console, Webhook (Slack/Discord/custom) |
| Capacidade extra (pedido/agenda/venda) | `capabilityRouter.ts` detecta, `agentServiceClient.ts` delega | `AgentService` (Python, standalone — ver `docs/artifacts/mapa-capacidades.html`) |

### Capacidades além de RAG (`enabledCapabilities`)

Além do RAG, um cliente pode ligar `"order"`, `"scheduling"` ou `"sales"` em
`config/agent.config.json` → `enabledCapabilities` — a mesma lista que
alimenta o roteamento (`src/orchestrator/capabilityRouter.ts`) e, no
produto, a precificação por tenant (ver "Mapa de Capacidades" em
`docs/artifacts/mapa-capacidades.html`). Hoje só `"order"` tem um backend de
verdade plugado (`AGENT_SERVICE_URL` → `DistributedOrderSystem/src/AgentService`);
`"scheduling"`/`"sales"` já são detectadas mas caem em handoff até ganharem
conector — nunca inventam uma resposta sem dado real.

## Setup

```bash
npm install
cp .env.example .env
cp config/agent.config.example.json config/agent.config.json
```

Edite `.env` com suas chaves e `config/agent.config.json` com o nome do
negócio, tom de voz, palavras-gatilho de handoff etc. (Fase 0 do runbook —
defina isso conversando com o negócio antes de codar).

Edite `knowledge/catalog.example.json` (ou aponte `knowledgeBasePath` para o
seu próprio arquivo) com uma linha por produto/serviço/política, no formato:

```json
{ "id": "...", "title": "...", "content": "specs, preço, garantia, FAQ..." }
```

Depois, indexe a base:

```bash
npm run ingest
```

Rode de novo sempre que o catálogo mudar (Fase 7 — atraso aqui é a causa nº 1
de informação errada).

## Testar sem conectar nenhum canal

```bash
npm run simulate
```

Abre um chat no terminal direto contra o orquestrador. Use para rodar a
matriz de testes da Fase 5 antes de conectar Telegram/WhatsApp de verdade:
pergunta dentro do escopo, pergunta fora do escopo, "você é IA?", pedido
explícito de humano, reclamação/frustração, mensagem ambígua.

Testes automatizados (parte determinística da matriz, sem chamar APIs
externas):

```bash
npm test
```

## Rodar o servidor (canais reais)

```bash
npm run dev    # hot reload
npm start      # produção
```

### Telegram

1. Crie um bot com o [@BotFather](https://t.me/BotFather) e pegue o token.
2. `TELEGRAM_BOT_TOKEN=...` no `.env`.
   Opcional: `HANDOFF_TELEGRAM_BOT_TOKEN=...` com um **segundo** bot, só para o
   atendente humano (alertas de handoff e respostas), com webhook em
   `/webhook/telegram-desk`. Ver `docs/HANDOFF_RELAY.md`, seção 4.1.
3. Exponha o servidor publicamente (ex.: `ngrok http 3000` em dev) e registre o webhook
   (endereços e comandos usados em produção: `docs/WEBHOOKS_E_URLS.md`):
   ```
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=<sua-url-publica>/webhook/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>
   ```

### WhatsApp (Meta Cloud API)

1. Configure um app no Meta for Developers com o produto WhatsApp.
2. Preencha `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`.
3. No dashboard do app, aponte o webhook para `<sua-url-publica>/webhook/whatsapp`
   (Meta faz uma verificação GET usando o `WHATSAPP_VERIFY_TOKEN`).

Se preferir um BSP (Twilio, Z-API, 360dialog) em vez da API direta da Meta,
implemente um novo `ChannelAdapter` seguindo `src/channels/whatsapp.ts` como
referência — o resto do pipeline não muda.

### Adicionar outro canal (Instagram, SMS, etc.)

Implemente `ChannelAdapter` (`handleWebhook`) em `src/channels/`, registre em
`src/server.ts`. O orquestrador não sabe nem precisa saber de onde a
mensagem veio.

## Produção (checklist da Fase 6)

- [ ] Log de conversas ativo (`data/audit-log.jsonl`, gerado automaticamente)
- [ ] Alerta de handoff configurado (`agent.config.json` → `"handoffNotifier": "webhook"` + `HANDOFF_WEBHOOK_URL`)
- [ ] Rate limit ajustado em `agent.config.json` → `rateLimit`
- [ ] Soft-launch: direcione só uma fração dos contatos para o bot na primeira semana

## Monitoramento (Fase 7)

- Leia `data/audit-log.jsonl` semanalmente (uma linha por turno, com
  `contextUsed` mostrando quais itens da base foram usados em cada resposta).
- Atualize a base (`knowledge/catalog.json` + `npm run ingest`) sempre que
  produto/preço/política mudar.
- Se o bot estiver fazendo handoff demais/de menos, ajuste
  `handoffKeywords`/`frustrationKeywords`/`minRelevanceScore` em
  `agent.config.json`.
