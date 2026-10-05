# Tutorial: debugar e testar o agente localmente

Guia prático para rodar o pipeline completo (canal → RAG → LLM → handoff) na
sua máquina, sem precisar de VM, Telegram ou WhatsApp configurados. Útil
tanto para debugar um bug quanto para testar uma mudança antes de subir pra
produção.

Além do `curl`, o projeto tem duas interfaces visuais pra isso (seções 5 e
6): um simulador de chat que imita o WhatsApp (`whatsapp.html`) e uma tela
pra configurar o comportamento do agente sem editar JSON na mão
(`settings.html`) — as duas sobem sozinhas junto com `npm run dev`.

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

Se preferir não ficar montando JSON de `curl` na mão, as duas seções
seguintes cobrem o mesmo canal `web` por uma interface visual.

## 5. Interface visual: simulador de chat (`whatsapp.html`)

Com o servidor rodando (`npm run dev`), abra no navegador:

```
http://localhost:3000/whatsapp.html
```

É uma página estática (`public/whatsapp.html`, servida pelo próprio
Express) que imita visualmente o WhatsApp e conversa com o mesmo
`/webhook/web` da seção 4 — só que com bolhas de mensagem, indicador de
"digitando..." e um status real de conexão no cabeçalho ("online" /
"offline — servidor não responde", baseado em polling de `GET /health`, não
um texto fixo).

Detalhes úteis pra quem for debugar com ela:
- `conversationId` e histórico ficam salvos no `localStorage` do navegador —
  sobrevive a reload da página, mas é por aba/navegador, não compartilhado.
- O ícone de menu (⋮) no cabeçalho reinicia a conversa (novo
  `conversationId`, limpa o histórico local) — útil pra testar do zero sem
  recarregar a página.
- O ícone de engrenagem (⚙️) no cabeçalho leva direto pra tela de
  configuração (seção 6).
- Se o `npm run dev` cair, aparece uma bolha de erro explicando o problema
  em vez de travar silenciosamente.

## 6. Tela de configuração (`settings.html`)

```
http://localhost:3000/settings.html
```

Formulário pra editar `config/agent.config.json` sem mexer no arquivo na
mão: nome do negócio, tom de voz, `temperature`/limite de tokens do LLM,
parâmetros de RAG (`topK`, nota mínima de relevância), limite de mensagens,
regras de handoff (palavras-gatilho, notificador, timeout) e capacidades
extras (order/scheduling/sales). Tem um link no topo pra voltar direto ao
simulador de chat da seção 5.

Como funciona por baixo (útil saber ao debugar):
- **Salvar** faz `POST /api/config`, que valida com o mesmo schema (zod) que
  já protege o arquivo, grava um backup em
  `config/agent.config.json.bak` e sobrescreve `config/agent.config.json`.
- A mudança já vale na próxima mensagem — **não precisa reiniciar**
  `npm run dev`. Teste isso mudando a `temperature` e mandando uma mensagem
  logo em seguida no `whatsapp.html`, na mesma sessão do servidor.
- Alguns campos ficam fora da tela de propósito: credenciais/tokens
  (continuam só no `.env`) e os caminhos do catálogo/índice vetorial
  (mostrados como somente leitura — trocar exige rodar `npm run ingest` de
  novo, não é um toggle).
- Um payload inválido (ex.: `temperature` fora de 0–1) volta como erro 400
  com a mensagem de qual campo falhou, em vez de salvar algo quebrado.

## 7. Breakpoint de verdade (VS Code)

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

## 8. Testando Telegram/WhatsApp de verdade (opcional)

Só necessário se o bug for específico de um desses canais (parsing de
payload, assinatura HMAC, etc.) — pra debugar a lógica do agente (RAG,
prompt, handoff), o canal `web` das seções 4–6 é suficiente e mais rápido.

1. Exponha o servidor local publicamente: `ngrok http 3000`.
2. Siga as instruções de registro de webhook no `README.md`, seção
   "Telegram" / "WhatsApp (Meta Cloud API)", usando a URL do ngrok como
   `<sua-url-publica>`.

## 9. Problemas comuns

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
- **`npm run dev` trava logo depois de `Debugger attached`, sem nenhuma
  linha depois** (nem `Mounted channel adapter`, nem erro nenhum) — não é
  bug do projeto: é o auto-attach do debugger do VS Code
  (`debug.javascript.autoAttachFilter: "smart"`, ver seção 7) ficando preso
  tentando negociar a conexão, geralmente depois de várias instâncias de
  `npm run dev` abertas e nunca fechadas direito na mesma sessão do VS Code.
  Contorno rápido: rode com o auto-attach desligado
  (`NODE_OPTIONS= npm run dev` no Git Bash) ou feche os processos `node`
  zumbis (`tasklist /FI "IMAGENAME eq node.exe"` + `taskkill /PID <pid> /F
  /T` pelos que sobraram de sessões anteriores) antes de tentar de novo.
