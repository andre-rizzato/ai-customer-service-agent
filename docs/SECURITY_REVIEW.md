# Revisão de segurança — 04/10/2026

Registro da revisão de código feita depois de ler o diagrama [Fluxo da
Requisição](artifacts/fluxo-da-requisicao.html), cobrindo os dois
repositórios envolvidos nesse fluxo: este (`ai-customer-service-agent`,
Node) e `DistributedOrderSystem` (o `AgentService`, Python). Oito pontos
levantados, em ordem de risco; cada um aqui documenta o que foi verificado,
o que foi corrigido, e — pros dois itens que não viraram código ainda — o
que falta e por quê.

Ver também [`STATUS.md`](STATUS.md) para o checklist geral do projeto; este
documento é só o recorte da revisão de segurança. O item #9 (prompt
injection e abuso do bot) foi acrescentado em 09/10/2026, com guia próprio:
[`SEGURANCA_PROMPT_INJECTION.md`](SEGURANCA_PROMPT_INJECTION.md).

---

## #1 — Falta de deduplicação de mensagem

**Risco:** tanto a Meta (WhatsApp Cloud API) quanto o Telegram podem
reentregar o MESMO webhook mais de uma vez — não só por timeout de resposta
do nosso lado, mas por qualquer instabilidade de rede do lado deles. Sem
rastrear quais mensagens já foram processadas, cada reentrega roda o
pipeline inteiro de novo: resposta duplicada pro cliente e custo de API em
dobro (embedding + até 3 chamadas de LLM, por mensagem reentregue).

**Status: corrigido.**

- `src/orchestrator/dedupeCache.ts` (novo) — cache em memória, por id de
  mensagem, com TTL de 10 minutos.
- `src/channels/whatsapp.ts` — dedup por `wamid` (id da mensagem da Meta).
- `src/channels/telegram.ts` — dedup por `update_id`.
- Cada canal guarda sua PRÓPRIA instância de `DedupeCache` (não
  compartilhada) — não há risco de colisão entre os dois formatos de id, e
  um bug num canal não pode afetar a deduplicação do outro.
- Testes: `tests/dedupeCache.test.ts`.

## #2 — Payloads de webhook "só status" entrando no pipeline

**Risco levantado:** um webhook de "status de entrega" (mensagem lida,
entregue, etc. — sem `messages`, só `statuses`) poderia ser tratado como se
fosse uma mensagem de texto real e acionar o pipeline à toa.

**Status: verificado, NÃO é um problema — nenhum código mudou aqui.**

`src/channels/whatsapp.ts` já navega a estrutura do payload com
`body.entry?.[0]?.changes?.[0]?.value?.messages ?? []` — um webhook de
`statuses` não tem a chave `messages`, então o `?? []` já resulta numa lista
vazia e o loop simplesmente não executa nenhuma vez. Confirmado lendo o
código linha a linha antes de assumir que precisava de correção.

## #3 — Sem validação de assinatura do webhook do WhatsApp

**Risco:** `WHATSAPP_VERIFY_TOKEN` só protege o HANDSHAKE único de registro
do webhook (a chamada GET inicial) — depois disso, qualquer POST pro
endpoint `/webhook/whatsapp` era aceito sem nenhuma prova de que veio
realmente da Meta. Alguém que descobrisse a URL pública podia forjar
mensagens inteiras.

**Status: corrigido.**

- `src/server.ts` — `express.json({ verify })` captura os bytes BRUTOS do
  corpo da requisição em `req.rawBody` (augmentado via `declare global` no
  mesmo arquivo), porque o cálculo de HMAC precisa dos bytes exatos que a
  Meta assinou — `JSON.stringify(req.body)` não é garantidamente idêntico
  ao corpo original (ordem de chaves, espaçamento).
- `src/channels/whatsapp.ts` (`verifySignature`) — calcula HMAC-SHA256
  sobre `req.rawBody` usando `WHATSAPP_APP_SECRET`, compara com o header
  `X-Hub-Signature-256` usando `timingSafeEqual` (evita ataque de timing).
  Assinatura inválida → `401`, corpo nunca é processado.
- `src/config.ts` — `WHATSAPP_APP_SECRET` novo (opcional no schema, mas com
  checagem cruzada: se `WHATSAPP_ACCESS_TOKEN` está setado, `APP_SECRET` é
  obrigatório — falha rápido na inicialização, não em produção na primeira
  mensagem) e adicionado à lista `SECRET_ENV_VARS` (Key Vault).

**Incidente no deploy desta mesma revisão:** a checagem acima derrubou o
`agente-atendimento` na VM em crash-loop logo depois do push — o secret
`whatsapp-app-secret` nunca tinha sido criado em `kv-agente-atendimento`,
porque a exigência não existia antes desta sessão. Corrigido adicionando o
secret no vault e reiniciando o processo (ver `STATUS.md`). Fica como nota
pra próxima vez: uma checagem fail-fast nova que depende de Key Vault
precisa do secret já existir ANTES do push que introduz a checagem, não
depois — senão o deploy automático quebra o serviço em produção mesmo com
os testes locais passando (o teste local não tem acesso ao Key Vault real).

## #4 — Autorização de cancelamento de pedido / identidade do solicitante

**Risco levantado:** nada impedia o agente de cancelar um pedido a partir
só da confiança da classificação de intenção, sem confirmar que quem está
pedindo é o dono do pedido.

**Decisão de produto (definida nesta revisão):** cancelamento de
pedido/ordem é **sempre** um handoff entregue a um atendente humano — o
agente nunca executa o cancelamento sozinho. Isso vale independente de
qualquer verificação de identidade, porque cancelar é destrutivo e difícil
de desfazer do lado do cliente.

**Status: corrigido (cancelamento) + groundwork (verificação de
identidade para consulta de status).**

Cancelamento:

- `DistributedOrderSystem/src/AgentService/graph.py` —
  `cancel_order_agent_node` não chama mais `order_backend.cancel()`. Define
  `final_reply` com uma mensagem fixa de transferência e o grafo roteia esse
  nó direto pro `END` (não passa mais por `generate_reply_node` — não há
  nada pro modelo decidir, então nem chama o LLM).
- `connectors/base.py` — `OrderBackend.cancel()` continua existindo no
  Protocol (uma ferramenta administrativa/painel humano ainda pode precisar
  cancelar de verdade depois que o atendente confirmar), só o CAMINHO
  AUTOMÁTICO do agente que foi removido.
- `src/orchestrator/orchestrator.ts` (Node) — checagem independente e
  redundante: se `agentResponse.intent === "cancel_order"` chegar do
  `AgentService` (por exemplo, se alguém chamar o `AgentService` diretamente
  sem passar pelo Node), o Node TAMBÉM nunca repassa a resposta do
  `AgentService` como se fosse a resposta final — aciona o
  `HandoffNotifier` e devolve uma mensagem de transferência própria.
  Defesa em profundidade: duas camadas independentes, cada uma já
  suficiente sozinha.

Verificação de identidade para CONSULTA de status (groundwork, não
verificação completa):

- Prioridade definida: vínculo de telefone (preferencial) > pergunta de
  verificação (fallback) > palavra-chave (despriorizado — não construído).
- `InboundMessage` → `orchestrator.ts` → `agentServiceClient.ts` →
  `AgentRequest.requester_phone` (Python) → `AgentState.requester_phone` →
  `order_info_agent_node` → `OrderBackend.get_status(order_id,
  requester_phone)`: o número de telefone de quem está perguntando agora
  trafega ponta a ponta.
  - WhatsApp: `requester_phone` = o próprio `wa_id` (já é o identificador
    verificado da conversa).
  - Telegram: `requester_phone` = `undefined` — um chat id do Telegram não
    é um número de telefone verificado, não existe hoje nada confiável pra
    comparar.
- **O que NÃO foi construído ainda, de propósito:** nenhum conector
  genérico (`RestOrderBackend`) de fato COMPARA `requester_phone` contra o
  telefone registrado no pedido — uma API REST genérica de um cliente
  qualquer não tem um nome de campo acordado pra "telefone do dono do
  pedido" na resposta, então qualquer comparação aqui seria um chute: ou
  nunca bateria (negando acesso sempre) ou nunca checaria nada de verdade
  (campo errado, sempre `None`). Essa comparação real só faz sentido dentro
  de um `CustomBackend` específico de cliente, que conhece o próprio schema
  — `connectors/custom.py` já documenta o padrão a seguir quando esse
  cliente existir.
- A pergunta de verificação (fallback pra quando não há telefone
  confiável, ex.: Telegram) **ainda não foi desenhada nem implementada** —
  fica como pendência técnica explícita (ver `STATUS.md`).

## #5 — Handoff sem estado persistente

**Risco:** um handoff só disparava uma notificação (console/webhook) e
respondia uma vez; na mensagem seguinte do mesmo cliente, o bot voltava a
responder normalmente por cima do atendente humano, porque nada marcava a
conversa como "já transferida".

**Decisão de produto (definida nesta revisão):** a partir do momento que
transfere, o bot sai de cena completamente — fica em silêncio até alguém
liberar a conversa ou até o timeout de segurança expirar.

**Status: corrigido (mecanismo de silêncio) — mecanismo de retomada em
tempo real (live relay) FICA PRA DEPOIS, decisão explicitamente adiada.**

- `src/orchestrator/handoffState.ts` (novo) — `HandoffStateStore`, estado
  persistido em DISCO (um JSON por conversa, em `CONVERSATIONS_DIR/handoff-state/`)
  — diferente do `RateLimiter` (só memória), porque perder esse estado
  num restart da VM seria uma regressão de segurança real (o bot voltaria
  a responder sozinho no meio de um atendimento humano).
  - `isActive()` — checado no INÍCIO do pipeline (`orchestrator.ts`, PASSO
    0), antes até do rate limiter. Também libera sozinho um handoff
    esquecido depois do timeout configurado (`agentConfig.handoffTimeoutHours`,
    default 4h) — sem isso, um atendente que esquece de liberar deixaria o
    cliente sem resposta do bot pra sempre.
  - `activate()` — chamado em TODO ponto que já aciona o `HandoffNotifier`
    (palavra-chave, falha do `AgentService`, capacidade sem conector,
    `cancel_order`).
  - `release()` — chamado automaticamente pelo timeout, ou manualmente via
    `scripts/releaseHandoff.ts <conversationId>` (comando explícito do
    atendente, enquanto não existe uma interface de verdade pra isso).
- `src/channels/whatsapp.ts` / `telegram.ts` — `handleMessage()` agora pode
  devolver uma string VAZIA (sinal de "não responda nada"); os adapters só
  chamam `sendMessage()` se a resposta não for vazia.

**Decisão explicitamente adiada — COMO o atendente de fato responde:**

- **Opção A** (já construída, é o que funciona hoje): atendente usa
  outro número/canal, recebe só o resumo via `HandoffNotifier`
  (console/webhook com o histórico completo), e continua o atendimento por
  fora (ligação, outro WhatsApp, outro canal). Simples de manter, mas o
  cliente percebe a troca de canal.
- **Opção B** (não construída): atendente responde em algum lugar (Slack,
  um painel simples) e o sistema faz um RELAY pra mesma conversa — cliente
  nunca percebe diferença, continua vendo tudo no mesmo número. Exige
  construir um mecanismo novo (capturar a resposta do atendente em algum
  lugar e chamar o `sendMessage()` que já existe, de volta pro cliente).
- Um número registrado na Cloud API do WhatsApp **não pode** ser usado
  simultaneamente no app normal do WhatsApp — isso já descarta "mesmo
  número via app" como opção dentro de A ou B; qualquer "mesmo número" só é
  possível via B (relay pelo sistema).
- A escolha entre A e B fica pra depois — fora do escopo desta revisão.

**Atualização 05/10/2026 — Opção B construída, com o atendente no Telegram:**
o alerta chega no chat do atendente com o bot e termina com `🆔 <id>`. O
atendente dá "Responder" nele e `src/handoff/relay.ts` entrega a resposta no
canal original: API do Telegram ou do WhatsApp, ou o polling do widget web.
Também há um Mini App opcional (`public/handoff-app.html`). Controles de
segurança:

- Só chat ids em `HANDOFF_TELEGRAM_CHAT_IDS` atuam como atendente, e o boot
  exige `TELEGRAM_WEBHOOK_SECRET` quando a lista existe (sem ele, um update
  "do atendente" poderia ser forjado).
- O id do destino sai do texto de uma mensagem escrita pelo **bot**
  (`reply_to_message.from.is_bot`). O texto do cliente citado no alerta tem
  o 🆔 neutralizado, e vale a última ocorrência. Assim um cliente não
  consegue desviar a resposta pra conversa de outra pessoa.
- O Mini App é autenticado pelo HMAC do `initData` (chave derivada do token
  do bot), com idade máxima de 24h e allowlist pelo `user.id`.
- O polling do widget devolve só as falas `human-agent`, nunca o histórico
  inteiro. O `sessionId` passou a ser `crypto.randomUUID()`.

## #6 — `agent-service` exposto em `0.0.0.0`

**Risco:** o processo PM2 do `AgentService` escutava em `0.0.0.0:8100`,
dependendo SÓ do NSG do Azure como proteção — uma única camada, sem defesa
em profundidade. O Node já fala com ele via `http://localhost:8100` (mesma
VM) — não havia motivo real pra essa porta ser alcançável de fora da VM.

**Status: corrigido, aplicado direto na VM (`vm-agente`, `20.127.12.103`).**

- Processo PM2 recriado com `--host 127.0.0.1` em vez de `--host 0.0.0.0`
  (`--interpreter none` precisa ser passado explicitamente ao recriar — sem
  isso o PM2 tenta rodar o binário do uvicorn, um script Python, através do
  interpretador Node e falha com `SyntaxError` logo de cara).
- Verificado antes de salvar: `curl localhost:8100/health` → `200` (Node
  continua alcançando normalmente), `curl 20.127.12.103:8100/health`
  (externo) → inalcançável. Teste de ponta a ponta real feito via
  `/webhook/web` com uma pergunta de status de pedido, resposta grounded
  recebida normalmente.
- `pm2 save` rodado depois da confirmação — sobrevive a reboot da VM.
- Comando exato documentado em
  `DistributedOrderSystem/src/AgentService/connectors/README.md` (seção
  "Processo na VM (PM2)") pra ser reproduzível sem precisar redescobrir por
  tentativa e erro se o processo precisar ser recriado no futuro.

## #7 — Fragilidade do roteamento por palavra-chave + risco de alucinação de status

**Risco:** se uma pergunta sobre status de pedido escapasse do
`capabilityRouter` (por não bater nenhuma palavra-chave configurada) e
caísse no caminho normal de RAG + LLM, o modelo podia inventar um status
plausível só pra "ser útil" — o pior tipo de erro aqui, porque parece uma
resposta real.

**Status: corrigido.**

- `src/orchestrator/promptBuilder.ts` — regra fixa nº1 agora proíbe
  explicitamente inventar "status de pedido", com uma explicação de POR QUE
  (status de pedido é dado em tempo real que só vem do `AgentService`,
  nunca da base de conhecimento estática) e QUE FAZER se uma pergunta desse
  tipo chegar até ali mesmo assim (admitir que não tem o dado, oferecer
  transferência — nunca supor).
- Reforça (não substitui) o roteamento por capacidade em
  `capabilityRouter.ts`, que continua sendo a primeira linha de defesa —
  esta é a segunda camada, pros casos que a primeira não pegar.

## #8 — LGPD para o vertical de clínica (dado de saúde)

**Status: documentação apenas — nenhuma mudança de código. Fica como
pendência técnica/jurídica explícita, não resolvida nesta revisão.**

Dado de saúde é "dado pessoal sensível" pela LGPD (art. 5º, II e art. 11) —
tem regras mais rígidas que dado pessoal comum. Antes de colocar este
produto em produção pra um cliente do vertical de clínica, pelo menos os
pontos abaixo precisam de uma decisão (jurídica, não só técnica) e,
dependendo da decisão, de implementação:

- **Base legal:** tratamento de dado de saúde exige consentimento
  específico e destacado do titular (art. 11, I) ou uma das hipóteses
  restritas do mesmo artigo (ex.: tutela da saúde, exercida por
  profissional de saúde ou serviço de saúde) — hoje o agente não coleta
  consentimento nenhum antes de processar uma mensagem.
- **Minimização:** o agente deve evitar pedir/reter mais dado de saúde do
  que o estritamente necessário pra agendar uma consulta ou responder uma
  dúvida — hoje não há nenhuma trava que impeça o histórico de guardar o
  que quer que o cliente digite.
- **Retenção e expurgo:** `ConversationStore` grava todo o histórico em
  disco, em texto plano, indefinidamente — não existe hoje nenhuma política
  de quanto tempo guardar nem rotina de expurgo automático. Desde
  09/10/2026 há mais dois lugares com dado pessoal, que precisam entrar em
  qualquer expurgo ou pedido de eliminação (art. 18):
  - `data/conversations/<id>.memory.json`: resumo gerado por LLM das
    conversas longas, que pode conter nome, cidade e o problema relatado;
  - `data/usage-log.jsonl`: contém o `conversationId`, que **no WhatsApp é
    o número de telefone do cliente**. Só tem tokens e modelo, nunca o
    texto da conversa.
- **Direitos do titular:** acesso, correção e eliminação de dados (art. 18)
  — não existe hoje nenhum mecanismo pra um titular pedir isso.
- **Criptografia em repouso:** o histórico em disco (`data/conversations/`)
  não é criptografado — pra dado de saúde isso é um ponto a endereçar antes
  de produção real.
- **Encarregado (DPO) e RIPD:** operar com dado sensível de saúde em escala
  tipicamente exige um Relatório de Impacto à Proteção de Dados Pessoais e
  um encarregado nomeado — isso é uma decisão do negócio/cliente, não algo
  que este repositório resolve sozinho.

Nenhum destes pontos bloqueia o uso atual do produto para o vertical
testado hoje (venda de produto físico, sem dado de saúde) — fica registrado
aqui para não ser esquecido quando/se um cliente do vertical de clínica
entrar em produção.

---

## #9 — Prompt injection e abuso do bot (acrescentado em 09/10/2026)

Não fazia parte da revisão original, que não olhou para o que um cliente
consegue fazer **pela própria conversa**. Revisado e testado em 09/10/2026.
Guia completo: [`SEGURANCA_PROMPT_INJECTION.md`](SEGURANCA_PROMPT_INJECTION.md).

- **Risco:** oferta falsa em nome da empresa (CDC art. 30), abuso de custo e
  alertas falsos ao atendente. Vazamento de dados de terceiros não é
  possível no lado Node: o bot não tem ferramentas e só vê o catálogo
  público e a própria conversa.
- **Teste adversarial** (`npm run eval:adversarial`, 16 ataques): **12/16
  antes, 16/16 depois.** As falhas iniciais:
  - desconto falso calculado na resposta;
  - mensagem de 100 mil caracteres processada;
  - rate limit burlado trocando o id da conversa;
  - transferência disparada pelo cliente.
- **Corrigido:**
  - teto do corpo HTTP e do texto por mensagem;
  - rate limit por IP no widget;
  - limpeza do mapa do rate limiter;
  - memória da conversa fora do system prompt;
  - sinal de transferência neutralizado;
  - checagem determinística de preço e porcentagem na resposta;
  - busca que falha não vira mais erro 500.
- **Pendente:** Nginx mandar o IP real (`X-Forwarded-For`) e `limit_req` na
  borda, limite de gasto no Console da Anthropic, e teste adversarial no
  AgentService. Ver a seção 5 do guia.

## Fora de escopo nesta revisão (já identificado, não corrigido)

- **Pergunta de verificação** como fallback de identidade quando não há
  telefone confiável (ver #4) — desenho ainda não feito.
- ~~**Mecanismo de relay em tempo real** pro atendente humano (Opção B do
  #5)~~ — construído em 05/10/2026, ver atualização no item #5.
- Os itens de hardening já listados em `STATUS.md` (`#Pendente`) que não
  vieram desta revisão (retry/timeout em chamadas HTTP do `AgentService`,
  `/health` checando dependências reais, etc.) continuam pendentes, sem
  mudança de prioridade por causa deste documento.
