# Status do projeto

Checklist consolidado de tudo que foi feito e do que falta, cobrindo os três
repositórios envolvidos: `ai-customer-service-agent` (este),
`DistributedOrderSystem` (o `AgentService`, Python) e `rizzatotech-site` (site
institucional). Para os passos manuais de domínio/email/WhatsApp, ver
[`GO_LIVE_CHECKLIST.md`](GO_LIVE_CHECKLIST.md).

Última atualização: 09/10/2026.

---

## Feito

### Site institucional (`rizzatotech-site`)

- [x] Domínio `rizzatotech.com` registrado (Hostinger) + email `contato@rizzatotech.com` (DKIM ativo)
- [x] Site Next.js + Tailwind v4 (export estático) — [repo](https://github.com/andre-rizzato/rizzatotech-site), [www.rizzatotech.com](https://www.rizzatotech.com)
- [x] Implantado em Azure Static Web Apps (`rg-rizzatotech-site`, plano gratuito), deploy automático via GitHub Actions a cada push
- [x] Domínio customizado + certificado TLS próprio ativos
- [ ] Login é só interface — sem autenticação/backend real ainda (deliberado, ver README do repo)

### Infraestrutura Azure (ambiente de teste)

- [x] Resource group `rg-agente-atendimento` (eastus), VM `vm-agente` (Ubuntu 22.04, Standard_B1s)
- [x] Azure Key Vault `kv-agente-atendimento` (RBAC) — segredos nunca em texto plano em nenhum dos dois serviços
- [x] Managed Identity (system-assigned) na VM, com role `Key Vault Secrets User`
- [x] `src/config.ts` (Node) e `config.py` (`AgentService`) buscam segredos do Key Vault via `DefaultAzureCredential` quando `KEY_VAULT_ENABLED=true`, com fallback idêntico ao `.env` local quando `false`
- [x] 1GB de swap configurado na VM (`/etc/fstab`) — ver incidente abaixo

### Agente de atendimento (Node)

- [x] Deploy completo na VM via PM2 + systemd (sobrevive a reboot)
- [x] Bug do endpoint da Voyage corrigido (`ai.mongodb.com`, não `api.voyageai.com`) e chave rotacionada
- [x] Pipeline RAG + LLM + handoff validado de ponta a ponta
- [x] Nginx + certificado Let's Encrypt (Certbot) na VM — `rizzato-tech.rizzatotech.com`, HTTPS com renovação automática
- [x] `businessName` do tenant de teste atualizado pra "Rizzato Systems"

### Canais

- [x] **Telegram** — bot `@rizzatotech_atendimento_bot`, webhook registrado, **mensagem real testada em produção** (resposta do RAG recebida no app)
- [x] **WhatsApp** — conta no Meta for Developers criada, número de teste liberado, webhook registrado e verificado (GET de verificação confirmado no log do Nginx)
- [ ] **WhatsApp — envio bloqueado**: número de teste do Meta é `+1` (EUA); regra antifraude barra `+1 → +55` (erro 130497, descasamento de país — não é verificação de negócio/CNPJ). Correção planejada: registrar chip `+55` na API em nuvem (semana de 11/10/2026) — ver `GO_LIVE_CHECKLIST.md` passo 4 pros cuidados (chip sai do WhatsApp normal, guardar o PIN de 6 dígitos)

### Arquitetura de capacidades

- [x] Interfaces `OrderBackend` / `SchedulingBackend` / `CatalogBackend` / `CheckoutBackend` (`DistributedOrderSystem/src/AgentService/connectors/`)
- [x] `RestOrderBackend` e `RestCatalogBackend` — genéricos, configuráveis por cliente via env var
- [x] `GoogleCalendarBackend` — implementado (slot-picking com cobertura de teste, sem rede)
- [x] `StripeCheckoutBackend` — implementado contra a API estável da Stripe
- [x] `PagSeguroCheckoutBackend` — implementado, **payload não verificado contra conta real** (ver `connectors/README.md`)
- [x] `capabilityRouter.ts` + `agentServiceClient.ts` (Node) — roteia pergunta de pedido pro `AgentService` antes do RAG, com fallback pra handoff em caso de falha
- [x] `enabledCapabilities` por cliente em `agent.config.json` (gate de `order`/`scheduling`/`sales`)
- [x] `AgentService` implantado na VM, rodando em paralelo ao agente Node
- [x] Fallback público (`dummyjson.com/carts`) configurado enquanto o `GatewayBff` não está acessível da VM

### Revisão de segurança (04/10/2026)

- [x] Deduplicação de mensagem por id (`wamid`/`update_id`) nos dois canais
- [x] Validação de assinatura HMAC-SHA256 em cada webhook do WhatsApp (`X-Hub-Signature-256`)
- [x] Cancelamento de pedido é sempre handoff humano — agente nunca cancela sozinho (duas camadas: Node e `AgentService`)
- [x] Groundwork de verificação de identidade pra consulta de status (`requester_phone` trafegando ponta a ponta) — comparação real ainda não implementada em nenhum conector genérico
- [x] Bot fica em silêncio total depois de um handoff (`HandoffStateStore`, persistido em disco), com liberação manual (`scripts/releaseHandoff.ts`) e timeout de segurança (4h, configurável)
- [x] `agent-service` na VM mudado de `--host 0.0.0.0` pra `127.0.0.1` — porta 8100 não é mais alcançável de fora da VM
- [x] Regra anti-alucinação de status de pedido no system prompt (RAG nunca inventa status)
- [x] **Incidente resolvido no deploy**: a nova checagem cruzada de `WHATSAPP_APP_SECRET` (item #3) derrubou o `agente-atendimento` na VM em crash-loop — o secret nunca tinha sido criado no Key Vault, porque não existia antes desta revisão. Corrigido adicionando `whatsapp-app-secret` em `kv-agente-atendimento` e reiniciando o processo; confirmado estável (sem mais restarts) e com os 3 canais montados. Lição: uma checagem fail-fast nova que depende de um secret precisa do secret já existir no Key Vault ANTES do deploy que introduz a checagem, não depois.
- Detalhe completo dos 8 pontos revisados, o que foi corrigido e o que ficou pendente: [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md)

### Relay de handoff pelo Telegram (05/10/2026 — Opção B do item #5)

Guia completo: [`HANDOFF_RELAY.md`](HANDOFF_RELAY.md).

- [x] `handoffNotifier: "telegram"`: alerta com histórico no chat do atendente com o bot (`HANDOFF_TELEGRAM_CHAT_IDS`), terminando com `🆔 <conversationId>`
- [x] Caminho principal: atendente dá **Responder** (reply) no alerta, ou em qualquer mensagem do bot com 🆔, e o texto vai pro cliente no canal original (`src/handoff/telegramDesk.ts` → `src/handoff/relay.ts`)
- [x] Mensagens novas do cliente durante o handoff são repassadas ao atendente (`onCustomerMessage`)
- [x] Mini App (`public/handoff-app.html`, botão "💬 Abrir conversa"): histórico completo + resposta + devolver ao bot, autenticado pelo `initData` assinado do Telegram (exige `PUBLIC_BASE_URL` https)
- [x] Botão "🤖 Devolver ao bot" e `/liberar`, além do `scripts/releaseHandoff.ts`; resposta do atendente renova o timeout de 4h
- [x] Widget web recebe a resposta por polling (`GET /webhook/web/poll`, só durante o handoff); `sessionId` agora é `crypto.randomUUID()` persistido por aba; `formatMessage` escapa HTML (era XSS)
- [x] `GET /webhook/web/health` criado — o widget mostrava "Offline" sempre porque essa rota não existia
- [x] Boot recusa `HANDOFF_TELEGRAM_CHAT_IDS` sem `TELEGRAM_WEBHOOK_SECRET` (senão dava pra forjar uma resposta de atendente pelo webhook)
- [ ] Deploy: definir `HANDOFF_TELEGRAM_CHAT_IDS` e `PUBLIC_BASE_URL` no `.env` da VM (não estão no Key Vault, não são segredo), conferir que `TELEGRAM_WEBHOOK_SECRET` já existe lá e mudar o `handoffNotifier` para `telegram` pela tela de configuração
- [x] Deploy do widget atualizado no `rizzatotech-site` (cópia vendorizada; o original no `DistributedOrderSystem` não foi alterado)

### Login de admin da tela de configuração (05/10/2026)

Guia: [`ADMIN_AUTH.md`](ADMIN_AUTH.md). Tutorial de uso (túnel, fluxo do save, desfazer): [`TUTORIAL_CONFIGURACAO.md`](TUTORIAL_CONFIGURACAO.md). `settings.html` e `/api/config` estavam abertos pra internet em produção.

- [x] `/api/config` exige ID token do Firebase (mesmo projeto do site) de um e-mail verificado em `ADMIN_EMAILS`, verificado sem `firebase-admin`; falha fechada (503) sem config
- [x] `settings.html` com login (Google ou e-mail/senha) e botão Sair; `CONFIG_AUTH_DISABLED=true` só pra dev local
- [ ] **Projeto Firebase não configurado em lugar nenhum**: secrets `NEXT_PUBLIC_FIREBASE_*` ausentes no GitHub do site (o login do site também não funciona em produção). Criar o projeto, cadastrar os secrets e preencher `FIREBASE_*` + `ADMIN_EMAILS` na VM (ver `ADMIN_AUTH.md` seção 5)
- [ ] Teste real de login pelo navegador (depende do item acima)
- [x] **Medida imediata em produção:** `/settings.html` e `/api/config` bloqueados no Nginx da VM (404, regex case-insensitive); acesso só por túnel SSH (`ssh -L 3000:localhost:3000 ...`). Ver `ADMIN_AUTH.md`

### Idioma do cliente + bot separado para o atendente (06/10/2026)

Guia: [`HANDOFF_RELAY.md`](HANDOFF_RELAY.md), seções 4.1 (dois bots + migração) e 4.2 (idioma).

- [x] **Idioma** (commit `59e02b6` + site `35646c4`, em produção): widget manda o idioma da página, Telegram manda `language_code`; LLM responde no idioma do cliente; mensagens fixas em pt/en/it (`src/orchestrator/messages.ts`); alerta avisa o atendente quando o cliente não fala português (o relay não traduz). Bug que motivou: as versões em/it do site recebiam resposta em português
- [x] **Dois bots** (commit `59e02b6`, em produção e **ativo desde 06/10 ~03:15 UTC**): `HANDOFF_TELEGRAM_BOT_TOKEN` dá ao atendente um bot próprio em `/webhook/telegram-desk`; `TELEGRAM_BOT_TOKEN` fica só pra clientes (simula o futuro WhatsApp). Motivo: com um bot só, o atendente nunca conseguia usar o bot como cliente
- **Migração em produção (seção 4.1 do `HANDOFF_RELAY.md`):**
  - [x] Passo 1: código publicado (06/10, ~02:50 UTC)
  - [x] Passo 2: bot de clientes criado no BotFather pelo usuário
  - [x] Passo 3a: token atual copiado para `handoff-telegram-bot-token` no Key Vault (06/10, ~02:55 UTC). Conferido: idêntico ao original e pertence ao `@rizzatotech_atendimento_bot` (que vira o bot do atendente)
  - [x] Passo 3b: usuário gravou o token do `@rizzatotech_bot` em `telegram-bot-token` (06/10, 03:00 UTC, no terminal dele). Entre o 3b e o 4, o `@rizzatotech_bot` ficou sem webhook e o `/start` não chegava a lugar nenhum: era o sintoma reportado
  - [x] Passo 4: `getMe` conferido (atendente = `@rizzatotech_atendimento_bot`, clientes = `@rizzatotech_bot`) + `setWebhook` dos dois; `getWebhookInfo` sem erro
  - [x] Passo 5: restart feito; log mostra `Handoff relay: 1 atendente(s) no Telegram (bot próprio, /webhook/telegram-desk)`
  - [ ] Passo 6: teste real pelo celular (bot novo como cliente → alerta no bot do atendente → Responder)

### Auditoria de segurança da VM (06/10/2026)

Relatório: [`SECURITY_AUDIT_2026-10-06.md`](SECURITY_AUDIT_2026-10-06.md). Como repetir: [`TUTORIAL_SEGURANCA_LOGS.md`](TUTORIAL_SEGURANCA_LOGS.md) + `scripts/security-check.sh`.

- [x] Varredura somente leitura: nenhuma invasão (todos os logins = sua chave ou deploy); ~5.600 tentativas SSH falhas e scanners web, todos sem sucesso
- [ ] 🔴 Restringir a chave de deploy do GitHub (hoje = shell completo + sudo sem senha)
- [ ] 🟠 Reboot pendente (kernel + libc6); PM2 sobe sozinho
- [ ] 🟠 `npm ci --omit=optional` no deploy (5 vulnerabilidades em `@xenova/transformers`, instalado mas não usado)
- [ ] 🟡 SSH (`PermitRootLogin no`, `X11Forwarding no`, `MaxAuthTries 3`), `server_tokens off`, `x-powered-by`, headers de segurança, Node em 127.0.0.1
- [ ] Alerta diário automático (cron + bot do Telegram) com as seções "alguém entrou" e "estranhos com sucesso"

### Encerramento de atendimento humano (05/10/2026)

- [x] Botão **✅ Encerrar atendimento** no alerta do Telegram e no Mini App, mais o comando `/encerrar`: aviso ao cliente + devolve ao bot (diferente de "Devolver ao bot", que não avisa)
- [x] Encerramento automático por inatividade (`handoffInactivityMinutes`, padrão 30, 0 desliga; campo na tela de configuração): varredura a cada minuto, aviso ao cliente e ao atendente
- [x] Widget e simulador mostram o aviso automático sem o rótulo "Atendente" (`fromHuman` no polling)
- [x] Deploy do código — commit `3a1cfa3`, já no `origin/master` e o widget no `rizzatotech-site` (commit `0a8f680`, já no `origin/main`)

### RAG avançado: hybrid search + HyDE + reranking + Qdrant (07/10/2026)

Antes: cosseno puro sobre `FileVectorStore` (Node) e zero retrieval (AgentService —
`general_question` ia direto pro LLM sem contexto nenhum). Guia completo do lado
AgentService: `AGENT_SERVICE_RAG_DOCUMENTATION.md` (`DistributedOrderSystem/docs/`).

- [x] **Node** (commit `f2788e8`): `KnowledgeBase.search()` migrado pro pipeline
  HyDE → embed → Qdrant → BM25 → RRF → rerank (Voyage `rerank-2`). Assinatura
  pública inalterada (`orchestrator.ts`/`promptBuilder.ts` não mudaram nenhuma
  linha). `minRelevanceScore` recalibrado de 0.72 pra 0.4 — a escala do rerank é
  mais baixa que a do cosseno puro da versão anterior
- [x] **AgentService** (`DistributedOrderSystem`, commit `33b27dd`): novo nó
  `retrieve_knowledge_node` (`rag_node.py`) com o mesmo pipeline, sobre duas
  coleções Qdrant — `faq_policy` (pública) e `order_support_notes` (exige
  `requester_phone` verificado; sem ele, o nó se recusa a consultar, nunca
  busca sem filtro — verificado empiricamente que vazaria nota de outro
  cliente). Atrás de `ORDER_HISTORY_RAG_ENABLED` (default `false`)
- [x] Qdrant hospedado em Azure Container Apps (`ca-qdrant`,
  `rg-agente-atendimento`), scale-to-zero, coleção compartilhada pelos dois
  catálogos
- [x] RAGAS (harness de qualidade de retrieval) nos dois lados —
  `eval/` (Node) e `tests/rag_eval/` (AgentService) — fora do deploy
  automático (custo de API paga + variância do LLM-judge), roda só sob
  demanda/workflow separado
- [x] **Bug encontrado e corrigido (07/10/2026)**: `generate_reply_node`
  (AgentService) respondia sempre em inglês (prompt fixo), mesmo pra cliente
  que escreveu em português — pouco visível antes, mas a nova intenção
  `order_history_query` passou a capturar muito mais mensagens nessa rota
  (ex.: "status do pedido" sem número, que cai no guard de privacidade acima).
  Corrigido: `agentServiceClient.ts` agora manda `language` (o mesmo valor que
  o Node já resolve pro seu próprio RAG, `promptBuilder.ts`) pro AgentService;
  `generate_reply_node` e os nós de resposta fixa (`cancel_order_agent`,
  `create/update/product_info_stub`, `clarify`) ficaram idioma-aware
  (`messages.py`, espelha `src/orchestrator/messages.ts`)
- [x] ~~Custo de latência do HyDE~~ — resolvido no lado Node em 09/10/2026:
  HyDE condicional (só roda quando a busca simples falha, ~10% das perguntas
  no eval) + cache. Ver seção "Custo de API" abaixo. No AgentService o HyDE
  continua rodando sempre (decisão em aberto lá)

### Custo de API e economia (09/10/2026)

Guias: [`CUSTO_API.md`](CUSTO_API.md) (API) e [`CUSTO_AZURE.md`](CUSTO_AZURE.md) (infraestrutura).

- [x] **Medição** (commit `f3a7495`): toda chamada paga (LLM, embedding, rerank) grava os tokens em `data/usage-log.jsonl`, com conversa e canal; `npm run usage:report` mostra custo por mês, por conversa, por etapa e por modelo (preços em `config/pricing.json`)
- [x] **Economia** (commit `af0128f`): HyDE condicional (`hydeSkipScore`), cache do HyDE, janela de histórico (`historyWindowTurns`, 15 turnos) + memória do que saiu dela (resumo acumulado em segundo plano + busca BM25 nos turnos antigos, `src/conversation/memory.ts`)
- [x] Medido antes/depois com o eval RAGAS (20 perguntas): *context precision* idêntica nos 20 casos, HyDE em 2/20 perguntas (antes 20/20), custo por pergunta US$ 0,0027 → US$ 0,0017. Conversa longa de 16 mensagens: bot lembrou 3/3 fatos do começo, igual ao histórico completo (`npm run eval:long-conversation`)
- [x] **Bug corrigido no harness RAGAS**: o juiz nunca tinha rodado (cliente síncrono numa métrica assíncrona); dataset ampliado de 8 para 20 perguntas, com 12 indiretas
- [x] Avaliado e descartado: trocar o HyDE por modelo local (não cabe na B1s; numa VM maior só empata com a API perto de ~40 mil perguntas/mês)
- [x] Azure: VM desligada pelo usuário em 09/10 (01:18 UTC); disco trocado para Standard HDD e 2 workspaces Log Analytics sem uso apagados, também pelo usuário. O IP público estático continua cobrando (~R$ 0,63/dia), deliberadamente
- [ ] **Deploy dos commits de custo e segurança** (`f3a7495`, `af0128f` e os seguintes): exige **ligar a VM antes** (com a VM desligada, o deploy do push falha) e voltar o disco para Premium antes de ligar (ver `CUSTO_AZURE.md`)
- [ ] Conferir os preços da Voyage e da OpenAI em `config/pricing.json` (os da Anthropic foram conferidos em 09/10; os outros foram estimados)
- [ ] O AgentService (capacidade `order`) chama o LLM no próprio processo e **não** é medido pelo `usage-log` — só aparece no Console da Anthropic
- [ ] Falhas de *faithfulness* que se repetem no eval (ex.: "como acompanho minha encomenda?" — a resposta acrescenta orientação fora do catálogo): ajuste de prompt, não de RAG
- [ ] Definir o preço por cliente depois de algumas semanas de `usage-log` real (mediana por conversa → franquia mensal, ver `CUSTO_API.md`)

### Prompt injection e abuso do bot (09/10/2026)

Guia: [`SEGURANCA_PROMPT_INJECTION.md`](SEGURANCA_PROMPT_INJECTION.md) (item #9 da `SECURITY_REVIEW.md`).

- [x] Teste adversarial `npm run eval:adversarial` (`scripts/evalAdversarial.ts`): 16 ataques (preço e desconto falsos, vazar prompt, falso "SYSTEM", fechar `<memoria>`, dizer que é humano, fora de escopo, produto e garantia inventados, forçar transferência, inglês, ofensa, injeção que sobrevive no resumo, mensagem gigante, burla do rate limit). **12/16 antes → 16/16 depois**
- [x] Antes do LLM: teto de 64kb no corpo HTTP, `maxMessageChars` (2000) por mensagem, rate limit por IP no widget (`webIpRateLimit`, 20/min), limpeza do mapa do rate limiter, sinal `[[TRANSFERIR]]` neutralizado na fala do cliente, busca que falha responde sem contexto em vez de erro 500
- [x] No prompt: memória da conversa longa saiu do system prompt e foi para a primeira mensagem do cliente (injeção armazenada)
- [x] Depois do LLM: checagem determinística de preço e porcentagem contra o catálogo (`outputGuard.ts`), com uma nova tentativa e, se falhar de novo, mensagem fixa oferecendo o atendente; transferência pedida pelo próprio cliente vira só oferta
- [x] Tráfego normal sem regressão: 0 intervenções da checagem nas 20 perguntas do eval e na conversa longa; memória 3/3
- [ ] **Nginx** (VM ligada): `X-Forwarded-For` no `proxy_pass` (sem ele, o limite por IP vale para todos os visitantes juntos) + `limit_req` na borda. Passo a passo na seção 5 do guia
- [ ] **Limite de gasto no Console da Anthropic** (última rede contra abuso distribuído)
- [ ] Teste adversarial no AgentService (capacidade "pedido")
- [ ] Limitações aceitas: valor citado pelo próprio cliente cai na mensagem fixa; preço de um produto atribuído a outro e prazos/specs em texto não têm trava determinística

### CI/CD

- [x] `deploy.yml` (Node) e `deploy-agent-service.yml` (`AgentService`) — GitHub Actions, deploy automático no push
- [x] Chave SSH dedicada só pra CI (não a pessoal), restrita (`no-port-forwarding,no-X11-forwarding,no-agent-forwarding`)
- [x] **Incidente resolvido**: `npm ci`/`pip install` rodando junto com os dois serviços já ativos travou a VM (B1s, sem swap) a ponto de não responder nem o SSH — corrigido com swap + os workflows agora param os dois serviços antes de instalar. Validado com deploy real depois da correção (56s, sucesso).

### Documentação e artefatos

- [x] [`Blueprint do Agente`](artifacts/blueprint-do-agente.html) — arquitetura de deploy, fluxo de mensagem, Key Vault
- [x] [`Mapa de Capacidades`](artifacts/mapa-capacidades.html) — capacidades plugáveis, decisões de pagamento/implantação/roteamento
- [x] [`Fluxo da Requisição`](artifacts/fluxo-da-requisicao.html) — Nginx/PM2/serviços, módulo por módulo, do webhook do WhatsApp até a resposta
- [x] [`Widget Embarcável`](artifacts/widget-embarcavel.html) — decisão de unificar o widget de chat do DistributedOrderSystem sob o Node Orchestrator (um cérebro, duas mãos); fases 1 a 4 já executadas
- [x] [`SSH_LINUX_GUIDE.pdf`](SSH_LINUX_GUIDE.pdf) — conectar na VM, comandos essenciais, receitas da rotina real do projeto
- [x] Diagramas exportados como SVG standalone em `artifacts/images/` (abaixo)
- [x] `GO_LIVE_CHECKLIST.md` — passos de domínio/email/DNS/Meta Developers + plano de teste com 2 tenants

<img src="artifacts/images/blueprint-do-agente.svg" alt="Diagrama do Blueprint do Agente" width="100%" />

<img src="artifacts/images/mapa-capacidades-camadas.svg" alt="Diagrama de camadas do Mapa de Capacidades" width="100%" />

<img src="artifacts/images/mapa-capacidades-multi-tenant.svg" alt="Diagrama de implantação multi-tenant do Mapa de Capacidades" width="100%" />

<img src="artifacts/images/fluxo-da-requisicao.svg" alt="Diagrama do fluxo da requisição, do WhatsApp até a resposta" width="100%" />

---

## Pendente

### Manual — só você consegue fazer (ver [`GO_LIVE_CHECKLIST.md`](GO_LIVE_CHECKLIST.md))

- [x] ~~Domínio, site mínimo, email corporativo~~ — feito, ver seção acima
- [x] ~~DNS + HTTPS do tenant de teste~~ — `rizzato-tech.rizzatotech.com`, feito
- [x] ~~Conta no Meta for Developers + número de teste do WhatsApp~~ — feito
- [x] ~~Webhook registrado~~ — Telegram testado com mensagem real; WhatsApp verificado, envio pendente do chip `+55`
- [ ] Chip `+55` registrado na API do WhatsApp (planejado semana de 11/10/2026)
- [ ] DNS + teste via canal real pro tenant `DistributedOrderSystem` (só validado via `/webhook/web` até agora)
- [ ] Catálogo real do negócio (hoje ainda é `catalog.example.json`)

### Técnico — segurança (ver `SECURITY_REVIEW.md`)

- [ ] Pergunta de verificação (fallback de identidade pra canais sem telefone confiável, ex. Telegram) — desenho ainda não feito (item #4)
- [x] ~~Mecanismo de relay em tempo real pro atendente humano (Opção B do item #5)~~ — feito em 05/10/2026 pelo Telegram, ver seção "Relay de handoff" acima
- [ ] LGPD pro vertical de clínica (dado de saúde) — checklist jurídico/técnico em aberto (item #8), não bloqueia o vertical testado hoje

### Técnico — capacidades

- [ ] `scheduling`/`sales`: detectadas pelo `capabilityRouter` mas sem nó de grafo real no `AgentService` ainda — hoje caem em handoff (comportamento correto, honesto, mas não é a capacidade funcionando de fato)
- [ ] `GoogleCalendarBackend` nunca testado contra uma conta Google real (sem service account disponível nesta sessão)
- [ ] `PagSeguroCheckoutBackend`: verificar endpoint/payload contra a doc atual (dev.pagbank.com.br) antes de produção
- [ ] `GatewayBff` do `DistributedOrderSystem` só roda local — capacidade `order` em produção de verdade depende disso (ou de outro backend real) existir em algum lugar acessível

### Técnico — widget embarcável

- [ ] Fase 5 do [`Widget Embarcável`](artifacts/widget-embarcavel.html): provisionar o par container+UAMI+KV por cliente quando houver 1º cliente pagante do gadget (fases 1–4 já concluídas)

### Técnico — infraestrutura

- [ ] VM `Standard_B1s` é pequena — o swap resolveu o travamento, mas vale considerar upgrade (B2s) se a carga crescer
- [ ] Hardening do `AgentService`: retry/timeout nas chamadas HTTP, log estruturado, `/health` checando dependências reais (hoje só confirma que o processo subiu)
- [ ] Modelo multi-tenant (container por cliente + User-Assigned Managed Identity + Key Vault por cliente) — **desenhado, não provisionado**. Só faz sentido quando houver um segundo cliente real.
- [ ] Ambientes de staging/produção — **deliberadamente adiado** pro primeiro cliente real, não é trabalho de agora

### Fora de escopo por enquanto (decisão já tomada)

- ~~RAG avançado (hybrid search, reranking, Qdrant, RAGAS)~~ — decisão revertida em 07/10/2026: migrado pros dois repositórios, ver seção "RAG avançado" acima. DSPy e fine-tuning (LoRA/QLoRA, DPO, vLLM) continuam fora de escopo, sem sinal de que o volume real justifique
- `npm audit` acusa vulnerabilidades em `@xenova/transformers` (dependência opcional, embeddings locais não usados) — pré-existente, não introduzido nesta sessão
