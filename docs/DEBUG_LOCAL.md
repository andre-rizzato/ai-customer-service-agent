# Tutorial: debugar e testar o agente localmente

Guia prático para rodar o pipeline completo (canal → RAG → LLM → handoff) na
sua máquina, sem precisar de VM, Telegram ou WhatsApp configurados. Útil
tanto para debugar um bug quanto para testar uma mudança antes de subir pra
produção.

Última atualização: 04/10/2026.

---

## 1. Setup inicial (só na primeira vez)

```bash
npm install
cp .env.example .env
cp config/agent.config.example.json config/agent.config.json
```

Edite o `.env` com pelo menos:
- `ANTHROPIC_API_KEY` (ou `OPENAI_API_KEY` + `LLM_PROVIDER=openai`)
- `VOYAGE_API_KEY` (ou `EMBEDDING_PROVIDER=local` pra rodar sem nenhuma API
  key de embeddings — mais lento na primeira vez, baixa um modelo local)

**Não precisa** preencher `TELEGRAM_BOT_TOKEN` nem `WHATSAPP_*` pra debugar
localmente — o canal `web` (`src/channels/web.ts`) existe justamente pra
isso: é um adapter REST simples, sem credencial nenhuma, pensado pra testar
com `curl`. Veja a seção 6 se quiser testar Telegram/WhatsApp de verdade.

Gere o índice vetorial da base de conhecimento (precisa rodar de novo sempre
que `knowledge/catalog.json` mudar):

```bash
npm run ingest
```

## 2. Testes automatizados (não chamam API externa)

```bash
npm test
```

24 testes cobrindo rate limiter, dedupe cache, detecção de handoff,
capability router, prompt builder e vector store — tudo determinístico, sem
custo de API. Rode isso primeiro sempre que mudar algo: é o jeito mais
rápido de pegar regressão óbvia antes de gastar uma chamada real de LLM.

## 3. Chat interativo no terminal (sem subir servidor HTTP)

```bash
npm run simulate
```

Abre um chat direto contra o `Orchestrator`, sem passar por nenhum canal.
Use pra rodar manualmente a matriz de casos da Fase 5 do runbook: pergunta
dentro do escopo, pergunta fora do escopo, "você é IA?", pedido explícito de
humano, reclamação/frustração, mensagem ambígua.

## 4. Servidor real + canal `web` via curl

Suba o servidor com hot reload:

```bash
npm run dev
```

Confirme no log que subiu (`Agent server listening on port 3000`) e que o
canal `web` foi montado. É normal ver `TELEGRAM_BOT_TOKEN not set` e
`WHATSAPP_... not set` — isso só significa que esses dois canais ficaram
desabilitados, o que é esperado sem as credenciais.

Em outro terminal, mande uma mensagem:

```bash
curl -X POST http://localhost:3000/webhook/web \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"teste-1","text":"qual a garantia do filtro FX200?"}'
```

A resposta vem no corpo do `curl` (`{"reply": "..."}`) — diferente de
Telegram/WhatsApp, o adapter `web` responde de forma síncrona, na mesma
requisição.

Teste também o gatilho de handoff, que roda ANTES do LLM:

```bash
curl -X POST http://localhost:3000/webhook/web \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"teste-2","text":"isso é um absurdo, quero falar com atendente"}'
```

Depois de testar, confira o que foi persistido:
- `data/conversations/<conversationId>.json` — histórico da conversa
- `data/audit-log.jsonl` — log de auditoria, uma linha por turno, com
  `contextUsed` mostrando quais itens da base entraram no prompt

`data/` está no `.gitignore`, então dados de teste não vão pro commit — mas
se quiser manter o repo limpo entre sessões de debug, apague os arquivos de
teste manualmente (`rm data/conversations/teste-*.json`) e remova as linhas
correspondentes do `audit-log.jsonl`.

## 5. Breakpoint de verdade (VS Code)

O projeto já vem com `.vscode/launch.json` configurado — não precisa criar
nada. Abra o arquivo `.ts` onde quer investigar, coloque um breakpoint, vá
em **Run and Debug** (Ctrl+Shift+D) e escolha uma das configurações:

| Configuração | O que debuga |
|---|---|
| **Debug: Server** | `src/server.ts` — mesmo processo do `npm run dev`, mas parado no breakpoint |
| **Debug: Simulate (chat CLI)** | `scripts/simulate.ts` — útil pra debugar o Orchestrator sem HTTP |
| **Debug: Ingest knowledge base** | `src/knowledge/ingest.ts` — pra inspecionar embeddings gerados |
| **Debug: Current Test File (Vitest)** | só o arquivo de teste aberto no editor |
| **Debug: All Tests (Vitest)** | a suíte inteira |
| **Attach: Running process (port 9229)** | anexa a um processo já rodando com `--inspect` |

Todas usam `tsx` direto (sem passo de build), então o breakpoint funciona em
qualquer `.ts` do projeto sem precisar compilar primeiro.

Se preferir não usar o VS Code: o workspace tem `debug.javascript.autoAttachFilter: "smart"`
configurado, então qualquer `node`/`tsx` rodado no terminal integrado já sobe
com o debugger anexado automaticamente (é por isso que `npm run dev` imprime
`Debugger listening on ws://...` mesmo sem pedir explicitamente).

## 6. Testando Telegram/WhatsApp de verdade (opcional)

Só necessário se o bug for específico de um desses canais (parsing de
payload, assinatura HMAC, etc.) — pra debugar a lógica do agente (RAG,
prompt, handoff), o canal `web` da seção 4 é suficiente e mais rápido.

1. Exponha o servidor local publicamente: `ngrok http 3000`.
2. Siga as instruções de registro de webhook no `README.md`, seção
   "Telegram" / "WhatsApp (Meta Cloud API)", usando a URL do ngrok como
   `<sua-url-publica>`.

## 7. Problemas comuns

- **`npm run ingest` falha com erro de autenticação** — confira se
  `VOYAGE_API_KEY` (ou `OPENAI_API_KEY`, se `EMBEDDING_PROVIDER=openai`) está
  preenchida no `.env`. Sem nenhuma API key, use `EMBEDDING_PROVIDER=local`.
- **Servidor sobe mas RAG nunca encontra nada** — rode `npm run ingest`
  depois de qualquer mudança em `knowledge/catalog.json`; o vector store em
  `data/vector-store.json` não se atualiza sozinho.
- **Processo não morre depois de `Ctrl+C` no `npm run dev`** — no Windows,
  `tsx watch` às vezes deixa um processo `node` residente. Confira com
  `netstat -ano | grep :3000` e finalize pelo PID do Windows
  (`taskkill //PID <pid> //F //T`) se precisar liberar a porta.
- **`KEY_VAULT_ENABLED=true` localmente** — não é necessário em dev; deixe
  `false` e preencha o `.env` direto. Key Vault é só pra produção na VM.
