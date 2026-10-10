# Migração do RAG para Qdrant (hybrid search + HyDE + reranking)

> Documenta a migração de 10/2026: `FileVectorStore` (cosseno puro sobre um
> JSON em disco) saiu, entrou a mesma técnica de RAG construída no
> `AgentService` irmão (`DistributedOrderSystem`) — Qdrant + BM25 + RRF +
> HyDE + reranking (Voyage `rerank-2`) — atrás da mesma assinatura pública
> de `KnowledgeBase.search()`. Ver também a documentação equivalente do
> lado Python: `DistributedOrderSystem/docs/AGENT_SERVICE_RAG_DOCUMENTATION.md`.

Última atualização: 09/10/2026. A migração (commit `f2788e8`) já está no
`origin/master` e em produção. Em 09/10 o pipeline ganhou o **HyDE
condicional** e o cache (commit `af0128f`), descritos abaixo.

---

## Por que mudar

O RAG original (`src/knowledge/vectorStore.ts`, removido nesta migração) já
comentava seu próprio ponto de troca: cosseno força-bruta sobre um JSON em
disco funciona bem até ~15-20 itens, depois disso degrada. O catálogo de
exemplo tem só 5 itens hoje, mas a técnica agora é a mesma usada em produção
no `AgentService` — reaproveitar o aprendizado de lá (inclusive os bugs já
resolvidos) em vez de reinventar.

## O que mudou — visão geral

| Antes | Agora |
|---|---|
| `FileVectorStore` — cosseno puro, índice em `data/vector-store.json` | `Qdrant` (local em dev, hospedado em produção) |
| Sem busca por palavra-chave | BM25 "na unha" (`src/knowledge/bm25.ts`) |
| — | RRF combina cosseno + BM25 (`src/knowledge/hybridSearch.ts`) |
| Sem reranking | Voyage `rerank-2` (`src/knowledge/reranker.ts`) |
| Sem HyDE | `src/knowledge/hyde.ts` — passagem hipotética descartável antes do embed |
| `minRelevanceScore: 0.72` (calibrado pra cosseno) | `minRelevanceScore: 0.4` (recalibrado pro score do reranker — ver "Achado real" abaixo) |
| Sem avaliação automatizada de qualidade de retrieval | Harness RAGAS em `eval/` (Python, separado do `package.json`) |
| Deploy sem nenhum teste antes | `deploy.yml` roda `typecheck` + `test` antes do deploy (job `test`, com `needs: test` no job `deploy`) |

A **assinatura pública não mudou**: `new KnowledgeBase()` e
`.search(query): Promise<RetrievedChunk[]>` continuam exatamente iguais —
`orchestrator.ts` e `promptBuilder.ts` não precisaram mudar nenhuma linha.

## O pipeline (`KnowledgeBase.search()`, `src/knowledge/knowledgeBase.ts`)

Desde 09/10/2026 a busca roda em **duas etapas**. A etapa 2 é o pipeline
original da migração. A etapa 1 existe para não pagar o HyDE (uma chamada de
LLM, ~40% do custo de LLM por pergunta) quando ele não faz falta:

```
search(query)
  ETAPA 1 — pergunta crua
    embeddings/*.ts   queryEmbedder.embed([query])                -> Voyage/OpenAI/local, conforme EMBEDDING_PROVIDER
    qdrantStore.ts    query(queryVector, 15)                      -> busca semântica, top 15 candidatos
    bm25.ts           bm25Rank(query, candidateTexts)             -> ranking por palavra-chave, mesmo pool
    hybridSearch.ts   reciprocalRankFusion([semantic, bm25])      -> combina os dois rankings
    reranker.ts       rerank(VOYAGE_API_KEY, query, fusedTexts)   -> Voyage rerank-2, top 3
    melhor score >= hydeSkipScore (padrão 0.5)?  -> devolve e PARA (sem HyDE)

  ETAPA 2 — só se a etapa 1 não achou nada com folga
    hyde.ts           generateHypotheticalPassage(query)          -> LLM, descartável, com cache por pergunta normalizada
    embed([hypothetical]) -> Qdrant -> BM25 -> RRF -> rerank       -> mesmas peças da etapa 1

  -> RetrievedChunk[] filtrado por minRelevanceScore (score do RERANKER, não cosseno)
```

Nas duas etapas, BM25 e rerank usam a pergunta **original**: o HyDE só muda
quais candidatos chegam ao reranker. Por isso pular o HyDE quando a etapa 1
já achou um trecho bem avaliado não muda a qualidade da busca. Medido com o
eval RAGAS (20 perguntas): a *context precision* ficou idêntica nos 20 casos,
e o HyDE rodou em 2/20 perguntas. Detalhes e números em
[`CUSTO_API.md`](CUSTO_API.md).

Reranking é **obrigatório**, não condicional a `EMBEDDING_PROVIDER` — decisão
deliberada: o score que `minRelevanceScore` compara só faz sentido como
score de relevância 0-1, que é exatamente o que o rerank devolve (o score
bruto do RRF, ~0.03, quebraria o corte silenciosamente). Por isso
`VOYAGE_API_KEY` é um requisito de verdade pra `KnowledgeBase` funcionar,
mesmo que o embedding em uso seja de outro provedor.

## Achado real: recalibração de `minRelevanceScore`

`0.72` era calibrado pra score de **cosseno puro** (onde uma resposta
claramente correta tende a ficar em 0.75-0.85+). O score do **reranker**
roda numa escala mais baixa — medido neste catálogo de exemplo:

| Pergunta | Resposta correta (rerank) | Irrelevante (rerank) |
|---|---|---|
| "vocês entregam em quanto tempo?" | 0.62 | ~0.30 |
| "quanto custa o filtro mais barato?" | 0.60 | ~0.28 |
| "qual a capital da frança?" (controle, sem resposta no catálogo) | — | 0.25-0.31 |

Manter `0.72` filtraria FORA as duas respostas corretas acima, voltando
"regra de vazio" pra toda pergunta — uma regressão real, não hipotética
(observada ao vivo contra o Qdrant hospedado antes da correção). Recalibrado
para `0.4`, que separa bem irrelevante (~0.3) de relevante (~0.5-0.65) neste
catálogo. **Quem já tem um `agent.config.json` de tenant em produção
precisa atualizar esse valor manualmente** — não há auto-migração, e o
valor antigo (0.72) continua filtrando tudo até alguém editar.

## Rota de debug: `GET /debug/rag-search?q=...`

Nova (`src/server.ts`), só montada quando `NODE_ENV != production` — devolve
os trechos recuperados crus (score do reranker, item completo), sem passar
pelo LLM de geração. Existe só para alimentar o harness RAGAS (`eval/`) e
depuração manual; o contrato público `/webhook/web/message` nunca expõe
isso (sempre `{reply, message}`).

## Avaliação de qualidade — `eval/` (Python, RAGAS)

Separado do `package.json` (RAGAS é Python-only). Chama o servidor Node já
rodando via HTTP (`/webhook/web/message` para a resposta,
`/debug/rag-search` para o contexto cru) e pontua `Faithfulness` e
`ContextPrecisionWithoutReference` — mesmas métricas e limiares do harness
irmão em Python. Ver `eval/README.md` para como rodar. Não entra no CI
padrão (custo real de API por execução + variância de LLM-como-juiz).

## Gate de CI novo (`deploy.yml`)

Antes desta migração, o workflow de deploy não rodava **nenhum** teste —
gap conhecido, registrado no plano de upgrade. Agora um job `test`
(`npm ci && npm run typecheck && npm run test`) roda num runner limpo do
GitHub antes do job `deploy` (`needs: test`) — nada é deployado se qualquer
um dos dois falhar.

## Infra Qdrant

- **Dev local:** `docker-compose.yml` do `AgentService` irmão
  (`DistributedOrderSystem/src/AgentService/docker/qdrant/`), reaproveitado
  — sem container próprio deste repo.
- **Produção:** mesmo Qdrant hospedado no Azure Container Apps que o
  `AgentService` já usa (`ca-qdrant`, scale-to-zero, Azure Files), coleção
  própria (`catalog`) dentro da mesma instância. Mesmos nomes de secret no
  Key Vault (`qdrant-url`/`qdrant-api-key`) nos dois repos — ver
  `src/config.ts`.

## Testes novos

`tests/bm25.test.ts`, `tests/hybridSearch.test.ts` (funções puras),
`tests/webContract.test.ts` (contrato `/webhook/web/*`, não existia antes),
`tests/agentServiceClient.test.ts` (contrato HTTP com o `AgentService`).
76/76 passando, `tsc --noEmit` limpo na época. Em 09/10/2026,
`tests/costSavings.test.ts` passou a cobrir o HyDE condicional e o cache
(104 testes no total).

## Estado do deploy

A migração (`f2788e8`) foi publicada pelo deploy de 08/10/2026 (run do commit `260aeb9`, sucesso) e roda em produção, com a VM desligada desde 09/10. O HyDE condicional
(`af0128f`, 09/10/2026) ainda não foi enviado: ver o `STATUS.md`, seção
"Custo de API e economia". O deploy depende de a VM estar ligada.

## Documentação relacionada

- `eval/README.md` — como rodar o harness RAGAS.
- `DistributedOrderSystem/docs/AGENT_SERVICE_RAG_DOCUMENTATION.md` — a
  mesma técnica do lado Python, incluindo os bugs encontrados lá (alguns
  reaplicados preventivamente aqui, ex.: o bug do `port` default do
  cliente Qdrant).
- `DistributedOrderSystem/src/AgentService/rag/README.md` — documentação a
  nível de módulo do lado Python.
