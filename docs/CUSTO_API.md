# Custo de API por cliente

Como medir quanto cada cliente gasta de API (LLM, embeddings, rerank) para
repassar esse custo. O custo da infraestrutura Azure (VM, disco, IP) está em
[`CUSTO_AZURE.md`](CUSTO_AZURE.md).

## O que é medido

Cada chamada paga grava uma linha em `data/usage-log.jsonl`
(`USAGE_LOG_PATH`), com os tokens que o próprio provedor informa na resposta
(`usage`), o modelo, a conversa e o canal:

| Etapa (`purpose`) | Chamada | Onde |
|---|---|---|
| `reply` | LLM: resposta ao cliente | `src/orchestrator/orchestrator.ts` |
| `hyde` | LLM: passagem hipotética do RAG (só quando a busca simples falha) | `src/knowledge/hyde.ts` |
| `summary` | LLM: resumo da conversa longa, a cada 10 turnos fora da janela | `src/conversation/memory.ts` |
| `reply-retry` | LLM: nova tentativa quando a resposta citou preço ou % fora do catálogo (raro; ver `SEGURANCA_PROMPT_INJECTION.md`) | `src/orchestrator/orchestrator.ts` |
| `query` | Embedding da pergunta | `src/embeddings/voyageEmbeddings.ts` |
| `rerank` | Rerank dos candidatos | `src/knowledge/reranker.ts` |
| `ingest` | Embedding do catálogo (`npm run ingest`), sem conversa | `src/embeddings/voyageEmbeddings.ts` |

Uma chamada feita fora de qualquer conversa fica sem `conversationId`, e o
relatório a soma em "Indexação do catálogo". Isso vale para o `npm run
ingest` e também para a rota `/debug/rag-search`, usada pelo eval só em dev.

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

O relatório mostra as **conversas cobráveis** (cada par cliente × dia, no
horário de Brasília, a mesma definição do catálogo; é o número que se
compara com a franquia do plano em `PRECIFICACAO.md`), os clientes
distintos, o custo total, o custo médio e a mediana **por conversa**,
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

## Economias já aplicadas (09/10/2026)

As três primeiras mudanças foram medidas com o eval RAGAS (`eval/`, 20
perguntas: 8 diretas e 12 indiretas ou coloquiais), rodado antes e depois
contra um Qdrant local com o catálogo de exemplo:

| | Antes | Depois |
|---|---|---|
| Casos aprovados | 14/20 | 16/20 |
| Context precision (por caso) | igual nos 20 casos | igual nos 20 casos |
| Perguntas que chamaram o HyDE | 20/20 | 2/20 |
| Custo médio por conversa (1 pergunta) | US$ 0,0027 | US$ 0,0017 (−37%) |

A diferença de aprovados vem da variação do juiz, não da mudança: a
*context precision* (qualidade da busca) ficou idêntica em todos os casos.
As falhas que sobraram são de *faithfulness* e aparecem nas duas rodadas
(ex.: "como acompanho minha encomenda?", em que a resposta acrescenta algo
que não está no catálogo). São um ponto de melhoria do prompt, não uma
regressão.

1. **HyDE condicional** (`src/knowledge/knowledgeBase.ts`): a busca roda
   primeiro com a pergunta crua. O HyDE só roda quando o melhor trecho fica
   abaixo de `hydeSkipScore` (padrão 0,5, em `agent.config.json`).
2. **Cache do HyDE** (`src/knowledge/hyde.ts`): uma pergunta repetida
   (normalizada, sem acento e sem pontuação) não chama o LLM de novo. O
   cache fica em memória e guarda no máximo 500 entradas.
3. **Janela de histórico** (`src/conversation/memory.ts`): vão literalmente
   só os últimos `historyWindowTurns` turnos (padrão 15).
4. **Memória do que saiu da janela** (mesmo arquivo):
   - um resumo acumulado, atualizado em segundo plano a cada 10 turnos (`purpose: "summary"` no relatório);
   - até 2 trechos antigos relevantes, achados por BM25 (sem custo).

   O resumo guarda só fatos do cliente e decisões, nunca preço ou
   especificação, que sempre vêm do catálogo.

   Num teste com uma conversa de 16 mensagens, o bot lembrou o nome, o
   produto indicado e a cidade da cliente (3/3, igual ao histórico
   completo). O custo dessa conversa ficou praticamente igual ao do
   histórico completo (US$ 0,046 contra US$ 0,047). A economia aparece em
   conversas mais longas: com o histórico completo, cada resposta reenvia
   todos os turnos anteriores, e com a janela o tamanho do prompt para de
   crescer.
