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
  −1. Mensagem grande demais? → recusa sem chamar API (widget: também rate limit por IP)
  0. Conversa em atendimento humano? → repassa ao atendente, bot fica em silêncio
  1. Rate limit por conversa
  2. Gatilho de handoff (palavra-chave / frustração) — roda ANTES do LLM
        ├─ Sim → notifica humano com histórico anexado, responde "vou te conectar"
        └─ Não → continua
  2.5 Capacidade (pedido/agenda/venda)? → delega ao AgentService ou faz handoff
  3. Busca na base (Qdrant + BM25 + RRF + rerank; HyDE só se a busca simples falhar)
  4. Monta o system prompt (3 regras fixas + contexto + memória da conversa)
  5. Chama o LLM (Claude ou OpenAI) com os últimos 15 turnos
  5.7 Checagem de valores: todo R$/% da resposta precisa estar no catálogo
  6. Loga o turno (histórico + audit log JSONL) e atualiza o resumo em 2º plano
        │
        ▼
Channel adapter envia a resposta de volta

Toda chamada paga de API (LLM, embedding, rerank) grava os tokens em
data/usage-log.jsonl  →  npm run usage:report
```

Detalhes de cada etapa: `docs/RAG_QDRANT_MIGRATION.md` (busca),
`docs/CUSTO_API.md` (custo e economias), `docs/HANDOFF_RELAY.md` (atendimento
humano), `docs/SEGURANCA_PROMPT_INJECTION.md` (proteções contra prompt
injection e abuso) e o diagrama `docs/artifacts/fluxo-da-requisicao.html`.

Cada peça é uma interface plugável:

| Peça | Interface | Implementações prontas |
|---|---|---|
| Canal | `ChannelAdapter` (`src/channels/types.ts`) | Telegram, WhatsApp Cloud API, Web (REST simples) |
| LLM | `LLMProvider` (`src/llm/types.ts`) | Anthropic (Claude), OpenAI |
| Embeddings | `EmbeddingProvider` (`src/embeddings/types.ts`) | Voyage AI (padrão), OpenAI, local (sem API key) |
| Base vetorial | `src/knowledge/qdrantStore.ts` | Qdrant (local em dev, Azure Container Apps em produção), com BM25 + RRF + rerank Voyage por cima (`knowledgeBase.ts`) |
| Notificação de handoff | `HandoffNotifier` (`src/handoffNotifier/types.ts`) | Console, Webhook (Slack/Discord/custom), Telegram (com relay de resposta ao cliente) |
| Memória da conversa | `ConversationMemory` (`src/conversation/memory.ts`) | Janela de turnos recentes + resumo acumulado + busca BM25 nos turnos antigos |
| Medição de custo | `recordUsage()` (`src/usage/usageMeter.ts`) | JSONL por chamada paga; relatório em `src/usage/usageReport.ts` |
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

A busca usa um Qdrant. Sem `QDRANT_URL` no `.env`, o padrão é
`http://localhost:6333`: suba um Qdrant local antes (Docker, ou o binário
oficial no Windows — ver `eval/README.md`). Depois, indexe a base:

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

Qualidade do RAG com LLM de verdade (custa API, roda sob demanda): harness
RAGAS em `eval/`, o teste de conversa longa
(`npm run eval:long-conversation`) e o teste adversarial de prompt injection
(`npm run eval:adversarial`). Ver `eval/README.md`.

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
- Custo de API por mês, por conversa e por etapa: `npm run usage:report`
  (lê `data/usage-log.jsonl`; preços em `config/pricing.json`). Ajustes de
  custo em `agent.config.json`: `hydeSkipScore` e `historyWindowTurns`. Ver
  `docs/CUSTO_API.md`.
- Custo da infraestrutura Azure (o que cobra mesmo com a VM desligada):
  `docs/CUSTO_AZURE.md`.
