# Custo de API por cliente

Como medir quanto cada cliente gasta de API (LLM, embeddings, rerank) para
repassar esse custo.

## O que é medido

Cada chamada paga grava uma linha em `data/usage-log.jsonl`
(`USAGE_LOG_PATH`), com os tokens que o próprio provedor informa na resposta
(`usage`), o modelo, a conversa e o canal:

| Etapa (`purpose`) | Chamada | Onde |
|---|---|---|
| `reply` | LLM: resposta ao cliente | `src/orchestrator/orchestrator.ts` |
| `hyde` | LLM: passagem hipotética do RAG | `src/knowledge/hyde.ts` |
| `query` | Embedding da pergunta | `src/embeddings/voyageEmbeddings.ts` |
| `rerank` | Rerank dos candidatos | `src/knowledge/reranker.ts` |
| `ingest` | Embedding do catálogo (`npm run ingest`), sem conversa | `src/embeddings/voyageEmbeddings.ts` |

A conversa chega até os providers por `AsyncLocalStorage`
(`src/usage/usageMeter.ts`), sem mudar nenhuma assinatura. Se a gravação
falhar, o erro vai só para o log e o atendimento continua normalmente.

**Não medido:** o AgentService (capacidade "pedido",
`/home/azureuser/agent-service`) chama o LLM no próprio processo. O consumo
dele aparece no Console da Anthropic, mas não neste log.

## Relatório

```bash
npm run usage:report                         # todos os meses + detalhe do mais recente
npm run usage:report -- --month 2026-10      # detalhe de um mês
npm run usage:report -- --usd-brl 5.40       # também em reais, com essa cotação
npm run usage:report -- --file outro.jsonl   # outro arquivo (ex.: copiado da VM)
```

Na VM, cada cliente tem a própria pasta `data/`, então o log de cada pasta
já corresponde a um cliente só:

```bash
ssh azureuser@20.127.12.103 'cd ~/agente-atendimento && npm run --silent usage:report -- --usd-brl 5.40'
```

O relatório mostra o custo total, o custo médio e a mediana **por conversa**,
o custo por resposta, e a divisão por etapa, por modelo e por canal. A
indexação do catálogo entra no total, mas não na média por conversa.

## Preços

Os preços estão em `config/pricing.json`, em USD por 1 milhão de tokens. A
chave é o prefixo do nome do modelo. Os preços da Anthropic foram conferidos
em 09/10/2026. **Os da Voyage e da OpenAI são aproximados: confira na página
de preços de cada um** e atualize `checkedAt`. Se um modelo aparecer no log
sem preço na tabela, o relatório o lista como "sem preço" e não soma o custo
dele.

## Como usar para cobrar

1. Deixe rodar algumas semanas com tráfego real e use a **mediana por
   conversa** para dimensionar a franquia. A média é puxada para cima por
   conversas longas.
2. Mensalidade = (franquia de conversas × custo por conversa × margem) +
   parte da infra (VM, Qdrant, Key Vault). Acima da franquia, cobre por
   conversa.
3. Para conferir a conta, compare o total do relatório com o Console da
   Anthropic (Usage/Cost). Com uma chave por cliente num Workspace próprio,
   o Console já separa o gasto por cliente e permite um limite de gasto
   para cada um.
4. Custos de WhatsApp (Meta) não passam por aqui: o ideal é que a conta do
   WhatsApp Business fique no nome e no cartão do cliente.
