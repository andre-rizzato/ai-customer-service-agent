# Custo da infraestrutura Azure

O que gera custo na assinatura `UnoSystems-Subscription`, o que continua
cobrando com a VM desligada e como conferir. O custo de **API** (LLM,
embeddings, rerank) está em [`CUSTO_API.md`](CUSTO_API.md).

Levantamento de 09/10/2026, em BRL. O Cost Management do Azure tem **8 a 24
horas de atraso**, então um gasto que "continua subindo" logo depois de
desligar algo pode ser só o atraso.

## Inventário

| Recurso | Grupo | Custo no mês até 09/10 | Cobra com a VM desligada? |
|---|---|---|---|
| VM `vm-agente` (B1s) | `rg-agente-atendimento` | R$ 7,71 (~R$ 1,30/dia ligada) | **Não**, se estiver *deallocated* (Parar no portal) |
| Disco `vm-agente_disk1_…` (era Premium SSD P4, hoje Standard HDD, ver abaixo) | `RG-AGENTE-ATENDIMENTO` | R$ 5,67 (~R$ 0,89/dia como Premium) | **Sim**: disco cobra pelo tamanho reservado |
| IP público `vm-agentePublicIP` (Standard, estático) | `rg-agente-atendimento` | R$ 3,99 (~R$ 0,63/dia) | **Sim**: IP estático reservado cobra sempre |
| Storage `stagenteatendimento` (Azure Files do Qdrant) | `rg-agente-atendimento` | centavos | Sim, mas é irrisório |
| Key Vault `kv-agente-atendimento` | `rg-agente-atendimento` | centavos | Por operação, irrisório |
| Container App `ca-qdrant` + ambiente `cae-agente-atendimento-2` | `rg-agente-atendimento` | R$ 0 | Não: escala até zero (`minReplicas: 0`) |
| Workspace Log Analytics `…6uoP` (eram 3, ver abaixo) | `rg-agente-atendimento` | R$ 0 | Só se receber logs |
| Static Web App `rizzatotech-site` | `rg-rizzatotech-site` | R$ 0 | Plano gratuito |

**Com a VM desligada e o disco ainda em Premium, o custo de fundo era ~R$
1,50/dia (~R$ 45/mês)**: disco e IP. Com o disco em Standard HDD, a parte do
disco cai bastante. O IP continua igual.

## A VM foi desligada em 09/10/2026, 01:18 UTC

Desligada (*deallocate*) pelo próprio usuário, conforme o Activity Log.
**Enquanto ela estiver desligada:**

- o bot do Telegram, o widget do site e o webhook do WhatsApp não respondem;
- **um push no `master` falha no deploy** (o GitHub Actions não alcança a
  VM). Ligue a VM antes de publicar.

## Como reduzir o custo enquanto a VM está parada

1. **Trocar o disco para Standard HDD.** Só é possível com a VM desligada,
   e não perde dados. **Volte para Premium antes de ligar**: com 892MB de
   RAM, a B1s depende de swap, e swap em disco lento piora muito o
   `npm ci` do deploy (ver o incidente em `STATUS.md`).
   ```bash
   # desligada:
   az disk update -g rg-agente-atendimento -n vm-agente_disk1_1e378f6b01e549ca9b688349df7074fc --sku Standard_LRS
   # antes de ligar:
   az disk update -g rg-agente-atendimento -n vm-agente_disk1_1e378f6b01e549ca9b688349df7074fc --sku Premium_LRS
   az vm start -g rg-agente-atendimento -n vm-agente
   ```
2. **IP público:** a única forma de parar a cobrança é apagar o IP, e aí o
   `20.127.12.103` se perde. Ele está no DNS
   (`rizzato-tech.rizzatotech.com`), nos webhooks, no deploy e em toda a
   documentação. Não vale a pena para uma pausa curta.
3. **Workspaces Log Analytics sem uso** (não custam nada hoje, é só
   limpeza):
   - **`workspace-rgagenteatendimento6uoP`: manter.** Ele recebe os logs do
     ambiente do Container Apps (`cae-agente-atendimento-2`), onde roda o
     Qdrant.
   - **`workspace-rgagenteatendimentoiJPC` e `workspace-rgagenteatendimentoJCS0`:
     sem vínculo.** Parecem restos de tentativas de criar o ambiente. Podem
     ser apagados. O Azure os mantém recuperáveis por 14 dias.
   ```bash
   az monitor log-analytics workspace delete -g rg-agente-atendimento -n workspace-rgagenteatendimentoiJPC --yes
   az monitor log-analytics workspace delete -g rg-agente-atendimento -n workspace-rgagenteatendimentoJCS0 --yes
   ```

Situação conferida em 09/10/2026: **os itens 1 e 3 já foram feitos** pelo
usuário. O disco está em `Standard_LRS` e só o workspace `6uoP` existe. **Ao
religar a VM, lembre de voltar o disco para `Premium_LRS` primeiro** (comando
no item 1).

## Como conferir

```bash
# O que existe e o estado da VM
az resource list --query "[].{name:name,type:type,rg:resourceGroup}" -o table
az vm list -d --query "[].{name:name,power:powerState}" -o table

# Custo do mês por recurso (Cost Management API)
SUB=$(az account show --query id -o tsv)
cat > /tmp/q.json <<'EOF'
{"type":"ActualCost","timeframe":"MonthToDate","dataset":{"granularity":"None",
 "aggregation":{"cost":{"name":"Cost","function":"Sum"}},
 "grouping":[{"type":"Dimension","name":"ResourceId"},{"type":"Dimension","name":"Meter"}]}}
EOF
az rest --method post --body @/tmp/q.json \
  --url "https://management.azure.com/subscriptions/$SUB/providers/Microsoft.CostManagement/query?api-version=2023-03-01" \
  --query "properties.rows" -o table

# Quem ligou/desligou a VM e quando
az monitor activity-log list -g rg-agente-atendimento --offset 7d \
  --query "[?contains(operationName.value,'virtualMachines')].{t:eventTimestamp,op:operationName.value,who:caller}" -o table
```

Na consulta de custo, troque `"granularity":"None"` por `"Daily"` e agrupe
por `ServiceName` para ver o custo dia a dia.

## Quando reavaliar

- **Tamanho da VM:** a B1s custa ~R$ 1,30/dia ligada. Subir para uma B2s
  (4GB) multiplica esse valor. Só faz sentido com carga real ou um segundo
  cliente: ver o trade-off no `CLAUDE.md` ("Decisões de infraestrutura") e
  em `STATUS.md`.
- **Modelo local no lugar do HyDE:** foi avaliado em 09/10/2026 e
  descartado. Não cabe na B1s, e numa VM maior só empataria com a API perto
  de ~40 mil perguntas/mês. Com o HyDE condicional, ele roda em ~10% das
  perguntas, e esse ponto de empate ficou ainda mais distante. Ver
  [`CUSTO_API.md`](CUSTO_API.md).
