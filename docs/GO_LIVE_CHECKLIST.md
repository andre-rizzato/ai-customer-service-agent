# Checklist de go-live — domínio, canais, teste end-to-end

Passos que só você consegue executar (pagamento, verificação de identidade,
contas que são suas) — nenhum deles é automatizável por aqui. Documentado na
ordem que evita retrabalho: cada passo depende do anterior já existir.

Dois tenants de teste cobrem os dois cenários do produto:
- **Rizzato Systems** — valida o pipeline genérico (canal → RAG → LLM), sem
  nenhuma capacidade extra. É o "cliente simples".
- **DistributedOrderSystem** — valida a capacidade `order` de ponta a ponta
  (Node → AgentService → `RestOrderBackend` → GatewayBff). É o "cliente com
  backend real".

Última atualização: 05/10/2026.

---

## 1. Domínio — ✅ feito

`rizzatotech.com` registrado na Hostinger.

## 2. Site + email corporativo — ✅ feito

- **Email**: `contato@rizzatotech.com`, configurado na Hostinger (DKIM ativo
  via os registros `hostingermail-*._domainkey` no DNS — não mexer neles).
- **Site institucional**: construído, implantado e no ar — ver
  [`rizzatotech-site`](https://github.com/andre-rizzato/rizzatotech-site)
  (repo), [www.rizzatotech.com](https://www.rizzatotech.com) (ao vivo, Azure
  Static Web Apps, HTTPS próprio, deploy automático a cada push). Login hoje
  é só interface, sem autenticação real — documentado no README do repo.

## 3. DNS + HTTPS do tenant de teste — ✅ feito (Rizzato Systems)

Separado do `www.rizzatotech.com` do passo 2 (esse é o site institucional).
Subdomínio do agente de atendimento, apontando pro IP da VM
(`20.127.12.103`, resource group `rg-agente-atendimento`):

```
A    rizzato-tech    20.127.12.103
```

HTTPS configurado na própria VM — Nginx como reverse proxy (porta 3000 →
80/443) + certificado Let's Encrypt via Certbot, renovação automática já
agendada. URL final: **`https://rizzato-tech.rizzatotech.com`**.

Pendente: subdomínio equivalente pro tenant `DistributedOrderSystem`
(`distributed-order.rizzatotech.com`) quando for testar a capacidade
`order` por um canal real (hoje só foi testada via `/webhook/web`, ver
`docs/STATUS.md`).

## 4. Meta for Developers + número de teste do WhatsApp — ✅ feito (com bloqueio conhecido)

Conta criada em `developers.facebook.com` com `contato@rizzatotech.com`, app
com produto WhatsApp, número de teste liberado, `WHATSAPP_ACCESS_TOKEN` e
`WHATSAPP_PHONE_NUMBER_ID` configurados no Key Vault.

**Bloqueio atual**: o número de teste que o Meta atribui é `+1` (EUA). A
regra antifraude da Meta compara país do remetente com país do
destinatário — `+1 → +55` (Brasil) é barrado (erro `130497`, "Business
account is restricted from messaging users in this country"). Isso não é
sobre verificação de negócio/CNPJ — é descasamento geográfico.

**Correção planejada (semana de 11/10/2026)**: registrar um chip brasileiro
(`+55`) na API em nuvem da Meta. O fluxo de envio não muda (servidor →
Meta → cliente, o chip nunca entra no caminho da mensagem) — só a
identidade do remetente passa a ser `+55`, o que tira a mensagem da regra
de descasamento de país. Cuidados a lembrar nessa hora:
- o chip **sai do WhatsApp normal** assim que registrado na API — não dá
  pra usar os dois ao mesmo tempo;
- manter o chip ativo com recarga (se a Meta pedir reverificação, o código
  chega nele);
- guardar o **PIN de 6 dígitos** do registro — necessário pra migrar ou
  registrar de novo no futuro.

## 5. Registrar o webhook

### Telegram — ✅ feito e testado de ponta a ponta

Bot `@rizzatotech_atendimento_bot` criado via BotFather, token e
`TELEGRAM_WEBHOOK_SECRET` no Key Vault, webhook registrado via
`setWebhook` apontando pra `https://rizzato-tech.rizzatotech.com/webhook/telegram`.
**Mensagem real enviada e respondida** (confirmado em 04/10/2026) — pipeline
completo (webhook → orchestrator → RAG/LLM via Key Vault → resposta) validado
em produção, não só em teste local.

### WhatsApp — ✅ webhook verificado, envio bloqueado até o chip +55 (Passo 4)

```
Callback URL:   https://rizzato-tech.rizzatotech.com/webhook/whatsapp
Verify token:   (no Key Vault, whatsapp-verify-token)
Campo assinado: messages
```

A verificação GET do Meta chegou e passou (confirmado no log do Nginx,
user-agent `facebookplatform/1.0`) — o webhook em si está correto. O que
falta é o número `+55` do Passo 4 pra mensagens realmente saírem.

## 6. Configurar os dois tenants de teste

### Rizzato Systems — ✅ feito

`config/agent.config.json` na VM atualizado:

```json
{
  "businessName": "Rizzato Systems",
  "enabledCapabilities": ["order"]
}
```

(Capacidade `order` deixada ligada pra continuar testando o fallback
`dummyjson.com` — ver Passo 6 do `DistributedOrderSystem`, abaixo.)

### DistributedOrderSystem (capacidade `order`) — pendente como canal real

```json
{
  "businessName": "DistributedOrderSystem (demo)",
  "enabledCapabilities": ["order"],
  "orderKeywords": ["status do pedido", "status do meu pedido", "cancelar pedido", "rastrear pedido"]
}
```

A capacidade `order` já está ativa e validada (ver Passo 7) — o que falta é
testá-la especificamente por um canal real (Telegram/WhatsApp) em vez de só
`/webhook/web`, e decidir se isso continua compartilhando o mesmo processo
Node do tenant Rizzato Systems ou ganha um subdomínio/config próprios.

`.env` do `AgentService` aponta hoje pra `ORDER_API_BASE_URL=https://dummyjson.com`
(fallback público) — `GatewayBff` do `DistributedOrderSystem` só roda local,
não alcançável de `rg-agente-atendimento`. Troca pra `GATEWAY_BFF_URL`
assim que houver um ambiente de verdade — não antes (infra de
staging/produção é trabalho do primeiro cliente real, não de agora). Ver
seção "Environments" em `DistributedOrderSystem/src/AgentService/connectors/README.md`.

Nota: a VM hoje roda um processo Node + um `AgentService` só, não dois
tenants isolados de verdade (o modelo multi-tenant com container +
identidade por cliente, do Mapa de Capacidades, não foi provisionado ainda
— ver `docs/STATUS.md`).

## 6.1 Relay de handoff pelo Telegram — ⏳ código pronto, configuração pendente

O atendente recebe o alerta no Telegram e responde ao cliente dali (widget,
WhatsApp ou Telegram). Guia completo, incluindo o passo a passo de deploy:
[`HANDOFF_RELAY.md`](HANDOFF_RELAY.md), seção 4. Resumo do que só você faz:

1. Mandar `/meuid` pro `@rizzatotech_atendimento_bot` e pôr o número em
   `HANDOFF_TELEGRAM_CHAT_IDS` no `.env` da VM, junto com
   `PUBLIC_BASE_URL=https://rizzato-tech.rizzatotech.com`.
2. Reiniciar o processo e trocar a notificação de handoff pra **Telegram**
   na tela de configuração.
3. Se o webhook do Telegram foi registrado com `allowed_updates`, registrar
   de novo sem ele (senão o botão "Devolver ao bot" não chega).

## 7. Teste de ponta a ponta — o que confirmar em cada tenant

| Tenant | Canal | Mensagem de teste | Resultado |
|---|---|---|---|
| Rizzato Systems | Telegram | mensagem real pro bot | ✅ **confirmado em produção** — resposta do RAG recebida no app de verdade |
| Rizzato Systems | `/webhook/web` | pergunta dentro do catálogo de exemplo | ✅ resposta baseada no RAG, sem handoff |
| Rizzato Systems | `/webhook/web` | "quero falar com atendente" | ✅ handoff dispara |
| DistributedOrderSystem | `/webhook/web` | "qual o status do pedido 1?" | ✅ `AgentService` responde com dado real (fallback `dummyjson.com`); LLM admitiu que não há campo de status em vez de inventar |
| DistributedOrderSystem | `/webhook/web` | "qual o status do pedido 99999?" (inexistente) | ✅ "não encontrado", honesto |
| DistributedOrderSystem | `/webhook/web` | `AgentService` inalcançável | ✅ handoff em vez de erro cru |
| DistributedOrderSystem | Telegram/WhatsApp | — | ⏳ pendente — só testado via `/webhook/web` até agora |
| Rizzato Systems | widget do site + Telegram do atendente | "quero falar com atendente" → Responder no alerta | ⏳ pendente — validado localmente com token falso (ver `DEBUG_LOCAL.md` 8.1), falta em produção |

## Checklist

- [x] Domínio registrado (`rizzatotech.com`)
- [x] Email corporativo configurado (`contato@rizzatotech.com`) e DKIM ativo
- [x] Site institucional no ar (`www.rizzatotech.com`, deploy automático)
- [x] Subdomínio do agente com HTTPS (`rizzato-tech.rizzatotech.com`, Nginx + Let's Encrypt)
- [x] Conta no Meta for Developers criada, número de teste liberado
- [x] Webhook do Telegram registrado e **testado com mensagem real**
- [x] Webhook do WhatsApp registrado e verificado (envio bloqueado até o chip `+55`)
- [x] Tenant Rizzato Systems configurado (`businessName`) e testado via canal real (Telegram)
- [ ] Chip `+55` registrado na API do WhatsApp (planejado semana de 11/10/2026)
- [ ] Subdomínio + teste via canal real pro tenant DistributedOrderSystem
- [ ] Relay de handoff: `HANDOFF_TELEGRAM_CHAT_IDS` + `PUBLIC_BASE_URL` na VM, notifier = Telegram, teste real widget → atendente → widget
