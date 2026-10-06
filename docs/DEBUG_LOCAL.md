# Tutorial: debugar e testar o agente localmente

Guia prático para rodar o pipeline completo (canal → RAG → LLM → handoff) na
sua máquina, sem precisar de VM, Telegram ou WhatsApp configurados. Útil
tanto para debugar um bug quanto para testar uma mudança antes de subir pra
produção.

Além do `curl`, o projeto tem duas interfaces visuais pra isso (seções 5 e
6): um simulador de chat que imita o WhatsApp (`whatsapp.html`) e uma tela
pra configurar o comportamento do agente sem editar JSON na mão
(`settings.html`) — as duas sobem sozinhas junto com `npm run dev`.

Última atualização: 05/10/2026.

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

Pra já abrir a tela de configuração (seção 6) no navegador automaticamente
junto com o servidor, use `npm run dev:ui` em vez de `npm run dev` —
equivalente, só que também abre `http://localhost:3000/settings.html`
sozinho. Dali tem um link direto pro simulador de chat (seção 5), então uma
sessão de debug local completa cabe num comando só.

Pra encerrar depois (sobretudo se `Ctrl+C` não for suficiente — ver seção
9), use `npm run stop` em vez de caçar PID na mão.

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
| **Debug: Server + abrir config no navegador** | mesma coisa, mas já abre `settings.html` sozinho quando o servidor sobe (equivalente a `npm run dev:ui`, só que pelo F5) |
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

### 8.1 Relay de handoff sem Telegram real

Dá pra testar o relay inteiro (ver [`HANDOFF_RELAY.md`](HANDOFF_RELAY.md))
sem bot de verdade: suba o servidor com um token **falso**. As chamadas à API
do Telegram (alerta, confirmação) falham com 401 no log, o que é esperado, e
o resto do fluxo funciona. Use uma pasta de dados separada pra não misturar
com as suas conversas:

```bash
PORT=3999 TELEGRAM_BOT_TOKEN="111:FAKE" TELEGRAM_WEBHOOK_SECRET="sec" \
HANDOFF_TELEGRAM_CHAT_IDS="555" CONVERSATIONS_DIR=/tmp/relay/conv \
AUDIT_LOG_PATH=/tmp/relay/audit.jsonl npx tsx src/server.ts
```

1. Abra `http://localhost:3999/whatsapp.html` e mande "quero falar com
   atendente". O bot responde que vai transferir, e as próximas mensagens
   ficam sem resposta.
2. Simule o atendente respondendo (reply) ao alerta, com o `conversationId`
   da conversa (está no log `[HANDOFF] conversation=...`). **No Git Bash do
   Windows, mande o JSON por arquivo**: o curl com o emoji 🆔 direto no
   argumento corrompe a codificação e o servidor não acha o marcador.

   ```bash
   node -e 'require("fs").writeFileSync("reply.json", JSON.stringify({update_id:1,message:{chat:{id:555},date:1,text:"Oi, sou o atendente",reply_to_message:{from:{is_bot:true},text:"alerta\n🆔 <conversationId>"}}}))'
   curl -X POST localhost:3999/webhook/telegram -H "Content-Type: application/json" \
        -H "X-Telegram-Bot-Api-Secret-Token: sec" --data-binary @reply.json
   ```

3. Em até 4s a resposta aparece no `whatsapp.html` com o rótulo "Atendente".
4. O Mini App (`/api/handoff/*`) exige um `initData` assinado com o token.
   Para gerar um válido, use a função `buildInitData()` de
   `tests/handoffRelay.test.ts` com o token falso e `user.id = 555`, e mande
   no header `X-Telegram-Init-Data`.

### 8.2 Relay de handoff com Telegram de verdade, local (bot de dev)

Use quando quiser ver o fluxo **inteiro** na sua máquina: alerta chegando no
seu Telegram, reply, botões, Mini App. Para só testar o fluxo de ponta a
ponta, é mais simples usar a página de produção
`https://rizzato-tech.rizzatotech.com/whatsapp.html`, que já fala com o bot
real.

**Por que um segundo bot:** o Telegram entrega as mensagens de um bot (inclusive
as suas respostas como atendente) para **um único endereço**, o webhook. O bot
de produção (`@rizzatotech_atendimento_bot`) aponta pra VM. Se você apontar o
webhook dele pro seu computador, **o bot de produção para de funcionar** pra
todo mundo enquanto durar o teste. Um bot de dev tem token e webhook próprios,
e os dois nunca se misturam.

> ⚠️ **Nunca rode `setWebhook` com o token de produção.** Antes de qualquer
> `setWebhook`, confira de qual bot é o token (passo 4). O token de produção
> fica no Key Vault (`telegram-bot-token`); o do `.env` local deve ser
> **sempre** o de dev.

**1. Criar o bot de dev (uma vez só).** No Telegram, abra o
[@BotFather](https://t.me/BotFather) e mande `/newbot`:

- nome: `Rizzato Tech DEV` (qualquer um);
- username: algo como `rizzatotech_dev_bot` (precisa terminar em `bot`).

O BotFather responde com o **token**. Guarde como guardaria uma senha.

**2. `.env` local.** O `.env` está no `.gitignore` e nunca é commitado:

```bash
TELEGRAM_BOT_TOKEN=<token do bot de DEV>
# qualquer string aleatória; gere com:
#   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
TELEGRAM_WEBHOOK_SECRET=<string aleatória>
HANDOFF_TELEGRAM_CHAT_IDS=<seu chat id, ver passo 5>
PUBLIC_BASE_URL=<URL https do ngrok, ver passo 3>   # só pro botão do Mini App
```

Na tela de configuração local (`http://localhost:3000/settings.html`), mude
**Notificação de handoff** para **Telegram** (é a config **local**; a de
produção não muda).

**3. Expor o servidor local.** Em outro terminal:

```bash
npm run dev          # terminal 1
ngrok http 3000      # terminal 2 -> copie a URL "https://xxxx.ngrok-free.app"
```

No plano gratuito do ngrok **a URL muda a cada vez** que ele reinicia. Quando
mudar, atualize `PUBLIC_BASE_URL` (e reinicie o `npm run dev`) e refaça o
passo 6.

**4. Conferir de qual bot é o token** (sempre, antes do passo 6):

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getMe"
# tem que mostrar "username":"rizzatotech_dev_bot" (o seu de DEV).
# Se mostrar rizzatotech_atendimento_bot, PARE: é o de produção.
```

**5. Descobrir o seu chat id.** Com o `npm run dev` e o ngrok rodando e o
webhook registrado (passo 6), mande `/meuid` pro **bot de dev**. Ou use o mesmo
número que está em `HANDOFF_TELEGRAM_CHAT_IDS` na VM: em chat privado, o chat
id é o seu id de usuário, igual em qualquer bot. Coloque no `.env` e reinicie
o `npm run dev`.

**6. Apontar o webhook do bot de DEV pro ngrok:**

```bash
curl -s "https://api.telegram.org/bot<TOKEN_DEV>/setWebhook" \
  -d "url=https://xxxx.ngrok-free.app/webhook/telegram" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET do .env>"

# conferir:
curl -s "https://api.telegram.org/bot<TOKEN_DEV>/getWebhookInfo"
```

Não passe `allowed_updates`: o padrão já inclui os cliques de botão
(`callback_query`), que o "✅ Encerrar" e o "🤖 Devolver ao bot" precisam.

**7. Testar.**

1. Abra `http://localhost:3000/whatsapp.html` e mande "quero falar com
   atendente" (ou "Nossos serviços" e depois aceite a oferta).
2. O alerta chega no seu Telegram, **vindo do bot de dev**. O terminal mostra
   `Handoff relay: 1 atendente(s) no Telegram.` no boot.
3. Dê **Responder** no alerta. Em até 4s a resposta aparece no `whatsapp.html`
   com o rótulo "Atendente".
4. Teste **✅ Encerrar**, **🤖 Devolver ao bot**, `/encerrar` e `/liberar`.
5. **Mini App:** o botão "💬 Abrir conversa" só aparece com `PUBLIC_BASE_URL`
   em https (a URL do ngrok). Na primeira abertura, o ngrok gratuito mostra
   uma página de aviso ("You are about to visit..."); clique em **Visit Site**.

**8. Ao terminar.** Pode só fechar o ngrok: o Telegram vai tentar entregar e
falhar, o que é inofensivo (é o bot de dev). Para deixar limpo:

```bash
curl -s "https://api.telegram.org/bot<TOKEN_DEV>/deleteWebhook"
```

E volte a notificação local para **Console**, se preferir ver os alertas no
terminal no dia a dia.

**Com dois bots de dev** (igual à produção depois da migração, ver
`HANDOFF_RELAY.md` seção 4.1): crie mais um bot no BotFather e use os dois no
`.env` local, um de clientes e outro do atendente:

```bash
TELEGRAM_BOT_TOKEN=<bot de dev de CLIENTES>
HANDOFF_TELEGRAM_BOT_TOKEN=<bot de dev do ATENDENTE>
```

Faça o `setWebhook` de cada um pro ngrok: o de clientes em
`/webhook/telegram`, o do atendente em `/webhook/telegram-desk` (o mesmo
`secret_token` serve pros dois). O boot deve mostrar
`Handoff relay: 1 atendente(s) no Telegram (bot próprio, /webhook/telegram-desk)`.
Com isso você pode conversar com o bot de clientes **pelo seu próprio
Telegram**, como cliente, e receber o alerta no bot do atendente.

**Testar outro idioma:** no `whatsapp.html`, acrescente `?lang=en` ou `?lang=it`
na URL (`http://localhost:3000/whatsapp.html?lang=it`). Sem isso ele usa o
idioma do navegador. No Telegram, vale o idioma do app de quem escreve.

**Problemas comuns deste modo:**

| Sintoma | Causa | Solução |
|---|---|---|
| Alerta não chega | `handoffNotifier` local ainda em `console`, ou chat id errado | tela de configuração local → Telegram; conferir `/meuid` |
| Reply no Telegram não chega no `whatsapp.html` | webhook do bot de dev não aponta pro ngrok atual (URL mudou) | refazer o passo 6 e conferir com `getWebhookInfo` |
| `getWebhookInfo` mostra `last_error_message: "Unauthorized"` ou 401 | `secret_token` do `setWebhook` diferente do `TELEGRAM_WEBHOOK_SECRET` do `.env` | refazer o passo 6 com o mesmo valor |
| Servidor não sobe: `HANDOFF_TELEGRAM_CHAT_IDS está definido mas TELEGRAM_WEBHOOK_SECRET não` | faltou o segredo no `.env` | adicionar (passo 2) |
| Você não consegue conversar com o bot de dev **como cliente** | seu chat id está na lista de atendentes; tudo o que você manda vai pro balcão | use o `whatsapp.html` como cliente, ou outra conta do Telegram |

## 9. Problemas comuns

- **`npm run ingest` falha com erro de autenticação** — confira se
  `VOYAGE_API_KEY` (ou `OPENAI_API_KEY`, se `EMBEDDING_PROVIDER=openai`) está
  preenchida no `.env`. Sem nenhuma API key, use `EMBEDDING_PROVIDER=local`.
- **Servidor sobe mas RAG nunca encontra nada** — rode `npm run ingest`
  depois de qualquer mudança em `knowledge/catalog.json`; o vector store em
  `data/vector-store.json` não se atualiza sozinho.
- **Processo não morre depois de `Ctrl+C` no `npm run dev`** — no Windows,
  `tsx watch` sobe um processo filho pra rodar `server.ts` de verdade e
  reinicia só ele a cada arquivo salvo; matar só o processo da porta não
  mata o processo "pai" do watcher, que fica órfão rodando sozinho. `npm
  run stop` resolve os dois de uma vez (acha pela porta configurada E por
  linha de comando) — rode isso em vez de caçar PID na mão.
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
