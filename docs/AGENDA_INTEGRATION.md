# Integração com agendas (Google Calendar, Microsoft Calendar, Calendly)

A capacidade `scheduling` (`agentConfig.enabledCapabilities`) deixa de cair
sempre em handoff humano: quando habilitada, o bot consegue checar
disponibilidade e marcar horário de verdade em um dos três calendários
abaixo. Cancelar ou reagendar **sempre** passa por um atendente humano, em
qualquer provedor — ver seção 4.

Última atualização: 11/10/2026.

---

## 1. Onde isso vive

Diferente do login de admin (`docs/ADMIN_AUTH.md`, que é só deste
repositório), a integração com agendas vive **do lado do AgentService**
(Python, repo `DistributedOrderSystem/src/AgentService`) — o mesmo serviço
que já atende a capacidade `order`. O Node só detecta a capacidade
(`src/orchestrator/capabilityRouter.ts`) e chama o mesmo endpoint HTTP
genérico (`POST /agent/message`) que já usa pra pedidos; quem decide qual
calendário usar, consulta disponibilidade e cria o evento é o AgentService.

```
Cliente → Node (capabilityRouter detecta "scheduling") → AgentService
  → classify_intent (check_availability / book_appointment /
    cancel_appointment / reschedule_appointment)
  → GoogleCalendarBackend | MicrosoftCalendarBackend | CalendlyBackend
  → resposta volta pro Node, que repassa ao cliente
```

Arquivos principais (todos em `DistributedOrderSystem/src/AgentService`):
`connectors/base.py` (contrato `SchedulingBackend`), `connectors/scheduling_*.py`
(um arquivo por provedor), `connectors/factory.py` (escolhe o provedor pela
env `SCHEDULING_BACKEND`), `scheduling_node.py` (os 3 nós do grafo),
`graph.py` (liga tudo), `intent_classifier.py` (as 4 intents novas).

## 2. As três credenciais — nenhuma é um fluxo de OAuth interativo

Decisão tomada com o usuário (11/10/2026): a agenda conectada é a do
**negócio** (cliente da Rizzato Tech), uma vez, pelo dono — nunca uma
agenda por cliente final. Por isso as três credenciais são **estáticas**,
sem redirect/consentimento por conversa:

| Provedor | O que gerar | Onde | Variáveis (`.env` do AgentService) |
|---|---|---|---|
| Google Calendar | Service account + chave JSON | Google Cloud Console → IAM → Service Accounts | `GOOGLE_SERVICE_ACCOUNT_FILE` (caminho do arquivo), `GOOGLE_CALENDAR_ID` |
| Microsoft 365/Outlook | App registration com permissão **Application** `Calendars.ReadWrite`, consentida pelo admin uma vez | Azure Portal → Azure AD → App registrations | `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` (segredo), `MICROSOFT_CALENDAR_USER_ID` (UPN/GUID da caixa) |
| Calendly | Personal Access Token | Calendly → Integrations → API & Webhooks | `CALENDLY_API_TOKEN` (segredo), `CALENDLY_EVENT_TYPE_URI` |

Comuns aos três (Google/Microsoft): `SCHEDULING_SERVICES` (`"corte:30,coloracao:90"`,
igual ao `services` dict no código), `SCHEDULING_BUSINESS_HOUR_START/END`,
`SCHEDULING_SLOT_MINUTES`, `SCHEDULING_TIMEZONE`. O Calendly não usa
nenhuma dessas — a duração e a disponibilidade já vêm definidas no próprio
event type, do lado do Calendly.

`SCHEDULING_BACKEND` escolhe qual dos três: `google_calendar` (padrão),
`microsoft_calendar` ou `calendly`.

**O que vai pro Key Vault vs `.env`** (mesma regra do resto do projeto,
`config.py` do AgentService): só os dois valores que são segredo de
verdade — `MICROSOFT_CLIENT_SECRET` (`microsoft-client-secret`) e
`CALENDLY_API_TOKEN` (`calendly-api-token`). Tenant id, client id, user id,
event type URI e calendar id não são segredo — são restritos pelo que foi
compartilhado/consentido, não por serem difíceis de adivinhar (mesmo
raciocínio já documentado para `GOOGLE_CALENDAR_ID`).

**Checagem fail-fast:** como em qualquer env var nova neste projeto, ela
precisa já existir na VM/processo **antes** do deploy que passa a exigi-la
— senão derruba o boot do `agent-service` (ver `CLAUDE.md`, "Produção").

## 3. O caso especial do Calendly

A API pública do Calendly **não tem** um endpoint de "criar um evento neste
horário exato em nome do negócio" — só o convidado, na própria página
hospedada do Calendly, consegue finalizar uma marcação. O que a API
permite:

- ler a disponibilidade real (`GET /event_type_available_times`) — isso é
  `check_availability()`, igual aos outros dois provedores;
- gerar um **link de agendamento de uso único** (`POST /scheduling_links`)
  — isso é `book()` **e** o que seria "reagendar": o Calendly não tem um
  endpoint de reagendamento separado, então o agente simplesmente emite
  outro link;
- cancelar um evento já marcado (`POST /scheduled_events/{uuid}/cancellation`)
  — isso é `cancel()`, e **é** uma chamada direta de verdade (mas o bot
  nunca a aciona sozinho — ver seção 4 abaixo).

Por isso, quando o cliente pede pra marcar um horário com um `SCHEDULING_BACKEND=calendly`,
a resposta do bot não é "agendado!" — é o link pro cliente escolher
(de novo, entre os mesmos horários que `check_availability()` já leu) e
confirmar lá. Ver `connectors/base.py`'s `SchedulingBackend.book()`
docstring (AgentService) pro contrato completo.

## 4. Cancelar ou reagendar é sempre handoff humano

Mesma política de `cancel_order` (`docs/SEGURANCA_PROMPT_INJECTION.md` e o
item #4 da revisão de segurança original): uma ação destrutiva nunca é
executada pelo bot sozinho, em nenhum provedor. Em duas camadas:

1. **No AgentService:** `cancel_reschedule_appointment_node`
   (`scheduling_node.py`) nunca chama `backend.cancel()` — devolve sempre a
   mesma mensagem fixa de handoff e termina o grafo, igual
   `cancel_order_agent_node` já fazia pra pedidos.
2. **No Node:** `orchestrator.ts` checa `agentResponse.intent === "cancel_appointment" || "reschedule_appointment"`
   e força o handoff independente do que o AgentService tenha respondido —
   rede de segurança adicional, mesmo se o lado Python tivesse um bug.

## 5. Testes

`DistributedOrderSystem/src/AgentService/tests/test_microsoft_calendar_backend.py`
e `test_calendly_backend.py` cobrem os dois conectores novos sem rede nem
credencial real (o método `_client`/`_access_token` é trocado por um dublê
no próprio teste — ver o cabeçalho de cada arquivo). `test_scheduling_slots.py`
continua cobrindo `compute_available_slots()`, reaproveitada pelo Google e
pelo Microsoft. Nenhum dos três provedores foi testado contra uma conta
real nesta sessão — antes de depender disso pra um cliente de verdade,
confirme contra um ambiente real (ver seção 2 pra gerar as credenciais).

## 6. Verificação ponta a ponta (quando houver credencial real)

1. Configure um dos três `SCHEDULING_BACKEND` + credenciais na VM, adicione
   `"scheduling"` em `agentConfig.enabledCapabilities` e alguma keyword em
   `agentConfig.schedulingKeywords` (tela de configuração ou
   `agent.config.json` direto).
2. `pm2 restart agent-service --update-env` (as credenciais são lidas pelo
   AgentService, não pelo Node).
3. `npm run simulate` perguntando algo como "tem horário livre pra corte na
   sexta?" — deve listar horários reais do calendário configurado.
4. Peça pra marcar um dos horários — deve criar o evento de verdade
   (Google/Microsoft) ou devolver o link do Calendly.
5. Peça pra cancelar — deve sempre virar handoff, nunca cancelar direto.
