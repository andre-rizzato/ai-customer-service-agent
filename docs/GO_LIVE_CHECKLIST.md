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

---

## 1. Domínio

Registre o domínio da Sua Empresa num registrador (Registro.br para `.com.br`,
ou Namecheap/GoDaddy/Cloudflare para `.com`). Decisão já tomada em
[Blueprint do Agente](artifacts/blueprint-do-agente.html): o domínio é seu,
não do cliente — um subdomínio por tenant de teste:

- `rizzato-systems.suaempresa.com.br` (ou `.com`)
- `distributed-order.suaempresa.com.br`

## 2. Site + email corporativo

Mínimo necessário pra passar na verificação de negócio do Meta for Developers
(passo 5) e não ter domínio "vazio":

- Email corporativo (`contato@suaempresa.com.br`) — Google Workspace ou
  Microsoft 365, qualquer um valida o domínio via DNS (próximo passo).
- Uma página simples no domínio raiz (`suaempresa.com.br`) — nome da empresa,
  o que faz, um jeito de contato. Não precisa ser o produto final; o Meta só
  checa que existe um negócio real por trás do número de WhatsApp.

## 3. DNS

Depois do domínio registrado, aponte os subdomínios pro IP público da VM
(`20.127.12.103`, ver `az network public-ip show` no resource group
`rg-agente-atendimento`):

```
A    rizzato-systems           20.127.12.103
A    distributed-order         20.127.12.103
MX   @                         (os registros que o provedor de email mandar)
TXT  @                         (verificação de domínio do provedor de email)
```

Confirme propagação antes de seguir (`dig rizzato-systems.suaempresa.com.br`
deve devolver o IP acima).

## 4. Meta for Developers + número de teste do WhatsApp

1. Crie uma conta em [developers.facebook.com](https://developers.facebook.com)
   usando o email corporativo do passo 2.
2. Crie um app, adicione o produto **WhatsApp**.
3. O Meta já libera um **número de teste** automaticamente (sem precisar de
   número de telefone real) — suficiente pra validar o pipeline antes de
   verificar um número comercial de verdade.
4. Anote `WHATSAPP_ACCESS_TOKEN` e `WHATSAPP_PHONE_NUMBER_ID` do painel do
   app — vão pro Key Vault do tenant (ver Passo 6).

## 5. Registrar o webhook

Para cada tenant, com o subdomínio já resolvendo (Passo 3):

```
# No painel do Meta for Developers → WhatsApp → Configuration → Webhook:
Callback URL:      https://<subdominio-do-tenant>/webhook/whatsapp
Verify token:       <o mesmo valor de WHATSAPP_VERIFY_TOKEN que você definiu>
Campo assinado:      messages
```

Guia completo de setup do canal (Telegram e WhatsApp) já existe em
`docs/DEPLOYMENT_GUIDE.pdf`, seções 6 e 7 — este checklist só adiciona a
parte de domínio que faltava antes dele.

## 6. Configurar os dois tenants de teste

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

**Estado atual da VM de teste (03/10/2026):** `GatewayBff` só roda local, não
alcançável de `rg-agente-atendimento` — por isso o `AgentService` lá está
configurado com `ORDER_API_BASE_URL=https://dummyjson.com` (API pública de
carrinho, sem auth) só pra ter algo real pra consultar enquanto não existe
um `GatewayBff` acessível. Ver seção "Environments" em
`DistributedOrderSystem/src/AgentService/connectors/README.md`. Troque pra
`GATEWAY_BFF_URL` assim que houver um ambiente de verdade — não antes
(infra de staging/produção é trabalho do primeiro cliente real, não de
agora).

## 7. Teste de ponta a ponta — o que confirmar em cada tenant

| Tenant | Mensagem de teste | Resposta esperada |
|---|---|---|
| Rizzato Systems | pergunta dentro do catálogo de exemplo | resposta baseada no RAG, sem handoff |
| Rizzato Systems | "quero falar com atendente" | handoff dispara (console/webhook) |
| DistributedOrderSystem | "qual o status do pedido 1?" (id válido no backend configurado) | `capabilityRouter` detecta `order`, `AgentService` responde com o dado real — confirma Node → AgentService → `RestOrderBackend` → backend configurado funcionando. **Testado na VM em 03/10/2026** com o fallback `dummyjson.com`: o LLM corretamente admitiu que o dado disponível não tem campo de "status", em vez de inventar um. |
| DistributedOrderSystem | "qual o status do pedido 99999?" (id inexistente) | resposta honesta de "não encontrado", nunca um status inventado — **confirmado** |
| DistributedOrderSystem | AgentService desligado/backend inalcançável | handoff dispara em vez de erro cru pro usuário (ver `orchestrator.ts`, catch de `callAgentService`) — **confirmado** na VM (testado com `GatewayBff` inalcançável antes de trocar pro fallback público) |

## Checklist

- [ ] Domínio registrado
- [ ] Email corporativo configurado e DNS (MX/TXT) propagado
- [ ] Site mínimo no ar
- [ ] Subdomínio por tenant apontando pro IP da VM
- [ ] Conta no Meta for Developers criada com o email corporativo
- [ ] Número de teste do WhatsApp liberado
- [ ] Webhook registrado e verificado (GET de verificação do Meta retornou 200)
- [ ] Tenant Rizzato Systems configurado e testado (RAG + handoff)
- [ ] Tenant DistributedOrderSystem configurado e testado (capacidade `order` ponta a ponta)
