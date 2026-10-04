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

Última atualização: 04/10/2026.

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

Isso cobre o requisito original deste passo (não ter domínio "vazio" pra
passar na verificação do Meta) — e virou o site real da empresa, não só um
placeholder.

## 3. DNS dos tenants de teste do agente — pendente

Importante: isso é **separado** do `www.rizzatotech.com` do passo 2 (esse é
o site institucional, hospedado no Azure Static Web Apps). Os subdomínios
abaixo são pros dois tenants de TESTE do agente de atendimento, apontando
pro IP da VM (`20.127.12.103`, resource group `rg-agente-atendimento`):

```
A    rizzato-systems           20.127.12.103
A    distributed-order         20.127.12.103
```

(O `MX`/`TXT` do email já está configurado desde o passo 2 — nenhum registro
novo de email é necessário aqui.)

Confirme propagação antes de seguir (`dig rizzato-systems.rizzatotech.com`
deve devolver o IP acima).

## 4. Meta for Developers + número de teste do WhatsApp — pendente

1. Crie uma conta em [developers.facebook.com](https://developers.facebook.com)
   usando `contato@rizzatotech.com`.
2. Crie um app, adicione o produto **WhatsApp**.
3. O Meta já libera um **número de teste** automaticamente (sem precisar de
   número de telefone real) — suficiente pra validar o pipeline antes de
   verificar um número comercial de verdade.
4. Anote `WHATSAPP_ACCESS_TOKEN` e `WHATSAPP_PHONE_NUMBER_ID` do painel do
   app — vão pro Key Vault do tenant (ver Passo 6).

## 5. Registrar o webhook — pendente

Para cada tenant, com o subdomínio já resolvendo (Passo 3):

```
# No painel do Meta for Developers → WhatsApp → Configuration → Webhook:
Callback URL:      https://<subdominio-do-tenant>.rizzatotech.com/webhook/whatsapp
Verify token:       <o mesmo valor de WHATSAPP_VERIFY_TOKEN que você definiu>
Campo assinado:      messages
```

Guia completo de setup do canal (Telegram e WhatsApp) já existe em
`docs/DEPLOYMENT_GUIDE.pdf`, seções 6 e 7 — este checklist só adiciona a
parte de domínio que faltava antes dele.

## 6. Configurar os dois tenants de teste — pendente

### Rizzato Systems (RAG puro)

`config/agent.config.json` sem nenhuma `enabledCapabilities`:

```json
{
  "businessName": "Rizzato Systems",
  "enabledCapabilities": []
}
```

### DistributedOrderSystem (capacidade `order`)

```json
{
  "businessName": "DistributedOrderSystem (demo)",
  "enabledCapabilities": ["order"],
  "orderKeywords": ["status do pedido", "status do meu pedido", "cancelar pedido", "rastrear pedido"]
}
```

`.env` desse tenant precisa de `AGENT_SERVICE_URL` apontando pro FastAPI
rodando (`uvicorn main:app --port 8100` dentro de
`DistributedOrderSystem/src/AgentService`) — local para teste, container
dedicado quando for pra VM (ver "Implantação multi-tenant" no
[Mapa de Capacidades](artifacts/mapa-capacidades.html)).

**Estado atual da VM de teste:** `GatewayBff` só roda local, não alcançável
de `rg-agente-atendimento` — por isso o `AgentService` lá está configurado
com `ORDER_API_BASE_URL=https://dummyjson.com` (API pública de carrinho, sem
auth) só pra ter algo real pra consultar enquanto não existe um `GatewayBff`
acessível. Ver seção "Environments" em
`DistributedOrderSystem/src/AgentService/connectors/README.md`. Troque pra
`GATEWAY_BFF_URL` assim que houver um ambiente de verdade — não antes
(infra de staging/produção é trabalho do primeiro cliente real, não de
agora).

Nota: a VM hoje roda um processo Node + um `AgentService` só, não dois
tenants isolados de verdade (o modelo multi-tenant com container +
identidade por cliente, do Mapa de Capacidades, não foi provisionado ainda
— ver `docs/STATUS.md`). Os dois "tenants" aqui são, por enquanto,
configurações de teste trocadas manualmente em `agent.config.json`, não dois
deploys simultâneos.

## 7. Teste de ponta a ponta — o que confirmar em cada tenant

| Tenant | Mensagem de teste | Resposta esperada |
|---|---|---|
| Rizzato Systems | pergunta dentro do catálogo de exemplo | resposta baseada no RAG, sem handoff |
| Rizzato Systems | "quero falar com atendente" | handoff dispara (console/webhook) |
| DistributedOrderSystem | "qual o status do pedido 1?" (id válido no backend configurado) | `capabilityRouter` detecta `order`, `AgentService` responde com o dado real — confirma Node → AgentService → `RestOrderBackend` → backend configurado funcionando. **Testado na VM em 03/10/2026** com o fallback `dummyjson.com`: o LLM corretamente admitiu que o dado disponível não tem campo de "status", em vez de inventar um. |
| DistributedOrderSystem | "qual o status do pedido 99999?" (id inexistente) | resposta honesta de "não encontrado", nunca um status inventado — **confirmado** |
| DistributedOrderSystem | AgentService desligado/backend inalcançável | handoff dispara em vez de erro cru pro usuário (ver `orchestrator.ts`, catch de `callAgentService`) — **confirmado** na VM (testado com `GatewayBff` inalcançável antes de trocar pro fallback público) |

Essas três últimas linhas já foram validadas na VM — o que falta é só
colocar isso atrás de um domínio/webhook de verdade (Passos 3-5), não
validar a lógica em si de novo.

## Checklist

- [x] Domínio registrado (`rizzatotech.com`)
- [x] Email corporativo configurado (`contato@rizzatotech.com`) e DKIM ativo
- [x] Site institucional no ar (`www.rizzatotech.com`, deploy automático)
- [ ] Subdomínio por tenant de teste apontando pro IP da VM
- [ ] Conta no Meta for Developers criada com `contato@rizzatotech.com`
- [ ] Número de teste do WhatsApp liberado
- [ ] Webhook registrado e verificado (GET de verificação do Meta retornou 200)
- [ ] Tenant Rizzato Systems configurado e testado via webhook real (RAG + handoff já validados localmente/VM)
- [ ] Tenant DistributedOrderSystem configurado e testado via webhook real (capacidade `order` já validada ponta a ponta na VM)
