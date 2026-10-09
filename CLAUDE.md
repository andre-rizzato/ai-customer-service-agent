# CLAUDE.md

Orientações pra quem (humano ou Claude) for trabalhar neste repositório.

## Decisões de infraestrutura: sempre pelo trade-off custo/performance

Antes de propor ou escolher entre duas opções de infraestrutura (VM vs
container, processo único vs réplicas, vault compartilhado vs vault por
cliente, etc.), avalie explicitamente três eixos — não só "qual é mais
robusto":

1. **Overhead de recurso** — quanto CPU/RAM a opção consome *além* do
   trabalho útil. Numa VM pequena (hoje: `Standard_B1s`, 892MB RAM), isso
   não é teórico — já causou um incidente real (`npm ci` + 2 processos
   residentes travou a VM a ponto de não responder nem SSH, documentado em
   `docs/STATUS.md`).
2. **Custo Azure** — o que muda na fatura, não só "dá mais trabalho pra
   configurar". Muitas vezes duas opções têm custo igual (zero adicional)
   até um certo limiar de escala, e só divergem depois dele.
3. **Isolamento/blast radius** — o que acontece quando uma coisa dá
   errado: um cliente trava, isso derruba os outros? Vaza memória, afeta
   quem mais? Esse é um eixo de *confiabilidade*, não só de "elegância
   arquitetural" — trate como parte do trade-off de performance, não como
   extra.

Precedente já decidido (ver conversa de 04/10/2026, `docs/STATUS.md`):
**segundo cliente de teste roda como processo PM2 simples** (copiar
pasta + config própria + porta própria + bloco de Nginx), **não** como
container Docker — o overhead do Docker numa VM com <1GB de RAM pesa mais
do que vale, nesse estágio. Mitigação de isolamento sem pagar esse custo:
usar `max_memory_restart` do PM2 pra limitar o blast radius de um processo
vazando memória, em vez de migrar pra Docker só por isso. Reavaliar quando:
(a) a VM for maior, ou (b) o número de clientes tornar o compartilhamento
sem limite genuinamente arriscado — ver "Implantação multi-tenant" em
`docs/artifacts/mapa-capacidades.html` pro desenho completo com Docker +
User-Assigned Managed Identity + Key Vault por cliente, já pronto pra
quando isso fizer sentido.

## Toda chave SSH gerada no Windows precisa de ACL restrita manualmente

`ssh-keygen` no Git Bash (Windows) **não** aplica uma permissão equivalente
ao `chmod 600` do Linux — o arquivo da chave privada sai com a ACL herdada
da pasta, que no normal inclui `SYSTEM`, `Administrators` e às vezes um SID
não resolvido, todos com controle total. Isso já aconteceu duas vezes neste
projeto: com `id_rsa` (achado e corrigido numa sessão anterior) e de novo
com `deploy_key_ci` (achado em 04/10/2026, só quando o usuário pediu pra
conferir — `icacls` mostrava 4 contas com `(F)` por herança).

**Sempre que gerar uma chave privada nova neste projeto** (`ssh-keygen -f
~/.ssh/nome_da_chave`), rodar na sequência, sem esperar dar erro de "Bad
permissions" ou alguém pedir pra conferir:

```powershell
icacls "C:\Users\work\.ssh\nome_da_chave" /inheritance:r
icacls "C:\Users\work\.ssh\nome_da_chave" /grant:r "$($env:USERNAME):(R)"
```

Não confiar no `ls -la` do Git Bash pra validar isso — ele traduz a ACL do
NTFS pra uma permissão POSIX aproximada (mostrou `644` pras duas chaves,
mesmo uma estando certa e a outra não). A fonte de verdade no Windows é
sempre `icacls`.

## Estilo de código: comentar generosamente, com preâmbulo

Diferente do padrão genérico de "comentar só quando o PORQUÊ não é óbvio",
**neste repositório o código é fortemente comentado** — é assim que o
projeto inteiro já está escrito (`src/config.ts`, `src/orchestrator/*.ts`,
`src/server.ts`, etc.) e é assim que deve continuar, inclusive em código
novo (telas HTML/JS novas como `public/whatsapp.html` e
`public/settings.html` seguiram a mesma regra). Esta instrução SOBRESCREVE
qualquer padrão default de "evite comentários" para este projeto.

Concretamente:

1. **Toda função/método/classe não trivial ganha um bloco "Preâmbulo:"**
   logo acima (ou como primeira linha do corpo, quando o preâmbulo precisa
   ficar dentro da função) explicando: o que a peça faz, quem chama ela e
   quando, e por que ela existe/por que foi desenhada assim — não só "o
   quê", mas o raciocínio por trás.
2. **Comentários linha a linha dentro do corpo**, explicando decisões não
   óbvias à medida que aparecem — tipo de dado escolhido, por que uma
   ordem de operações importa, qual bug/incidente motivou uma checagem
   específica, trade-off considerado e descartado. Uma linha de código só
   fica sem comentário quando o que ela faz já é auto-evidente a partir do
   nome das variáveis/funções.
3. **Comentários em português**, no mesmo tom explicativo e detalhado do
   resto do código já existente — não frases telegráficas tipo "// loop
   principal", e sim o contexto de verdade (ex.: por que um campo é
   `readonly`, por que uma validação roda ANTES de outra, o que quebraria
   se o comentário fosse ignorado).
4. Isso vale tanto pra arquivos `.ts` quanto pra HTML/CSS/JS das telas em
   `public/` — comentar blocos de CSS não óbvios e funções JS do mesmo
   jeito.

Motivo: o código aqui é lido e mantido por alguém (humano ou Claude) sem
contexto prévio de por que cada decisão foi tomada — o comentário é o que
preserva esse raciocínio entre sessões, em vez de ele se perder.

## Produção: onde as coisas vivem e o que um push faz

- **VM:** `vm-agente` (`rg-agente-atendimento`, `azureuser@20.127.12.103`).
  App em `/home/azureuser/agente-atendimento` (PM2: `agente-atendimento`,
  porta 3000) e `/home/azureuser/agent-service` (PM2: `agent-service`,
  `127.0.0.1:8100`). Config de negócio em `config/agent.config.json`
  (`AGENT_CONFIG_PATH`), editada pela tela ou à mão (aí precisa de
  `pm2 restart agente-atendimento --update-env`).
- **Push no `master` deste repo = deploy automático na VM**
  (`.github/workflows/deploy.yml`). **Push no `main` do `rizzatotech-site` =
  deploy do site** (Azure Static Web Apps). Commit não é push: só fazer push
  quando o usuário pedir explicitamente.
- Ao esperar um deploy, **filtre pelo commit** (`gh run list --json headSha,...`):
  logo depois do push, o run mais recente ainda é o do deploy **anterior**
  (já "completed: success"), e conferir só o status dá falso positivo.
  Confirme na VM (uptime do PM2 de poucos segundos, arquivo novo presente).
- O deploy **nunca** sobrescreve `.env` nem `config/agent.config.json`
  (`--exclude`). Segredos ficam no Key Vault; variáveis que não são segredo
  (`HANDOFF_TELEGRAM_CHAT_IDS`, `PUBLIC_BASE_URL`) ficam no `.env` da VM.
- **Checagem fail-fast nova exige a variável já existir na VM antes do
  deploy** (lição do incidente de 03/10 com `WHATSAPP_APP_SECRET`). Ex.:
  `HANDOFF_TELEGRAM_CHAT_IDS` sem `TELEGRAM_WEBHOOK_SECRET` derruba o boot.
- O site institucional **não** lê nem grava a config do bot: ele só embute o
  widget de chat. O widget é uma **cópia vendorizada e modificada** em
  `rizzatotech-site/public/chat-widget/chat-widget.min.js` (o original no
  `DistributedOrderSystem` não recebe as mudanças). Mudou o contrato do canal
  web (`/webhook/web/*`)? Atualize essa cópia junto.

## Tela de configuração: fechada para a internet

Desde 06/10/2026, `/settings.html`, `/api/config` e `/api/auth/config`
respondem 404 de fora (`/etc/nginx/snippets/agente-admin-block.conf` na VM).
Acesso só por túnel: `ssh -L 3000:localhost:3000 azureuser@20.127.12.103`
(ver `docs/TUTORIAL_CONFIGURACAO.md`).

- **Não remover o bloqueio** enquanto não houver login de admin publicado.
- **Rotas do Express não diferenciam maiúsculas** (`/API/CONFIG` chega no
  mesmo handler). Todo bloqueio no Nginx precisa de regex case-insensitive
  (`~*`). Rota administrativa nova = adicionar ao snippet.
- O login de admin via Firebase (`src/admin/firebaseAuth.ts`,
  `docs/ADMIN_AUTH.md`) existe **só no working tree, sem commit**: depende de
  um projeto Firebase que ainda não existe (o login do próprio site também não
  está ligado em produção). Ao commitar outras coisas, não arrastar esses
  arquivos junto sem o usuário pedir.

## Telegram: dois papéis, até dois bots

- `TELEGRAM_BOT_TOKEN` = bot de **clientes** (simula o futuro atendimento por
  WhatsApp: LLM + transferência). `HANDOFF_TELEGRAM_BOT_TOKEN` = bot **do
  atendente** (alertas, Responder, botões, Mini App), em
  `/webhook/telegram-desk`. Sem a segunda variável, um bot só faz os dois
  papéis (e o atendente nunca consegue usar o bot como cliente).
- Tudo que é do atendente usa `deskBotToken` (`src/handoff/attendants.ts`):
  alerta, confirmações do balcão e a **validação do initData do Mini App**
  (o Telegram assina com o token do bot onde o botão foi clicado).
- Migração em produção (Key Vault + `setWebhook` dos dois bots):
  `docs/HANDOFF_RELAY.md`, seção 4.1.

## Idioma

O cliente é atendido no idioma dele: o widget manda `language` (pt/en/it,
pela página do site), o Telegram manda `language_code`. Isso vai pro prompt e
pras mensagens fixas (`src/orchestrator/messages.ts`; mensagem nova ao
cliente = entrada nova lá, nas 3 línguas, nunca string solta em português).
O relay não traduz: o alerta avisa o idioma pro atendente.

## Relay de handoff: invariantes que não podem quebrar

Detalhes em `docs/HANDOFF_RELAY.md`. O que é fácil quebrar sem perceber:

1. O marcador `🆔 <conversationId>` é **sempre a última linha** das mensagens
   do bot pro atendente. Texto do cliente citado passa por `sanitizeQuoted()`.
   O id só é aceito de `reply_to_message` escrito pelo **bot**. Isso impede um
   cliente de desviar a resposta do atendente pra conversa de outra pessoa.
2. `HumanRelay.reply()` **entrega primeiro e grava depois** (o histórico nunca
   tem fala que o cliente não recebeu). `close()` libera o handoff **mesmo se
   a entrega falhar** (atendimento pendurado é pior).
3. O polling público (`GET /webhook/web/poll`) devolve **só** turnos
   `human-agent` ou `relayed`, nunca o histórico. O `sessionId` funciona como
   chave de acesso, por isso é `crypto.randomUUID()`. Id desconhecido não pode
   entrar no cache (`ConversationStore.exists()`).
4. São dois timers diferentes: `handoffInactivityMinutes` (ninguém fala,
   encerra **com aviso**, varredura a cada minuto) e `handoffTimeoutHours`
   (atendente não responde, bot volta **em silêncio**).

## Segurança: verificar antes de afirmar

- `scripts/security-check.sh` (só leitura) responde "alguém entrou?",
  "tentaram?" e "algum estranho teve sucesso em rota sensível?":
  `ssh azureuser@20.127.12.103 'bash -s' -- 7 < scripts/security-check.sh`.
  Como ler: `docs/TUTORIAL_SEGURANCA_LOGS.md`.
- Armadilha: buscar só `Accepted` no log do SSH também pega
  `...not in PubkeyAcceptedAlgorithms` (chave **rejeitada**). Use
  `Accepted (publickey|password)`.
- Logs do Nginx duram **14 dias** (logrotate). Para afirmar algo sobre o
  passado (ex.: "ninguém acessou X"), leia o atual, o `.1` **e** os `.gz`.
- Antes de dizer que algo "está configurado" ou "funciona em produção",
  conferir na VM (só leitura) ou no repositório. Em 06/10 isso revelou que o
  Firebase do site nunca foi configurado e que um save da tela tinha sido
  feito pelo próprio usuário, não por um invasor.
- Pendências da auditoria de 06/10 (chave de deploy com shell + sudo, reboot,
  `npm ci --omit=optional`, endurecimento de SSH/headers) estão em
  `docs/SECURITY_AUDIT_2026-10-06.md` e no `docs/STATUS.md`.

## Armadilhas do ambiente de desenvolvimento (Windows)

- **Não chamar `python`**: no Windows é o atalho da Microsoft Store e fica
  travado esperando. Para scripts auxiliares, use `node -e`.
- **`curl` no Git Bash corrompe argumentos não-ASCII** (o emoji `🆔` virou
  outro texto e o relay "não funcionou"). Para payload com acento/emoji,
  grave em arquivo e mande com `--data-binary @arquivo.json`.
- **Servidor de teste em background deixa processo órfão**: parar a task do
  `tsx` mata só o pai; o `node` filho continua escutando a porta (e responde
  com o código **antigo**, o que confunde o teste seguinte). Depois de cada
  teste, confira a porta e mate o processo e o pai (`npm run stop` faz isso na
  3000). Para testes, use outra porta (ex. `PORT=3999`) e pastas temporárias
  (`CONVERSATIONS_DIR`, `AUDIT_LOG_PATH`, `AGENT_CONFIG_PATH` no scratchpad),
  pra não misturar com os dados locais.
- **Nunca rodar `setWebhook` com o token de um bot de produção**
  (`@rizzatotech_atendimento_bot`, e o bot de clientes depois da migração da
  seção 4.1 do `HANDOFF_RELAY.md`): o Telegram só entrega pra um endereço, e
  apontar pra uma máquina local derruba o bot de produção. Telegram real em
  dev = um **bot de dev** separado (`docs/DEBUG_LOCAL.md`, seção 8.2). Antes de
  qualquer `setWebhook`, conferir o dono do token com `getMe`.
- Para testar o relay sem bot real: `TELEGRAM_BOT_TOKEN="111:FAKE"`. As
  chamadas ao Telegram falham com 401 no log (esperado) e o resto do fluxo
  funciona (`docs/DEBUG_LOCAL.md`, seção 8.1).

## Outros documentos relevantes

- `docs/STATUS.md` — checklist consolidado do que está feito/pendente, nos três repositórios do projeto.
- `docs/GO_LIVE_CHECKLIST.md` — passos manuais de domínio/email/canais.
- `docs/WEBHOOKS_E_URLS.md` — todas as rotas públicas, para onde aponta cada webhook (Telegram, WhatsApp, widget) e os comandos exatos de `setWebhook`.
- `docs/TUTORIAL_CONFIGURACAO.md` — tutorial: abrir a tela de configuração em produção (túnel SSH), o que acontece ao salvar, desfazer, e por que o site não mexe na config.
- `docs/SECURITY_AUDIT_2026-10-06.md` + `docs/TUTORIAL_SEGURANCA_LOGS.md` — auditoria da VM e como verificar tentativas de ataque (`scripts/security-check.sh`).
- `docs/HANDOFF_RELAY.md` — relay de handoff: atendente responde ao cliente pelo Telegram (reply ou Mini App), configuração, segurança e limitações.
- `docs/CUSTO_API.md` — medição de consumo de API por conversa (`data/usage-log.jsonl`) e relatório de custo por cliente (`npm run usage:report`).
- `docs/artifacts/` — docs de arquitetura publicados (Blueprint do Agente, Mapa de Capacidades).
