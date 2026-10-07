# eval/ — gate de qualidade RAGAS (Python)

Porta do harness RAGAS do AgentService irmão
(`DistributedOrderSystem/src/AgentService/tests/rag_eval/`), adaptada porque
aqui o sistema sob teste é um servidor Node já em execução, não um processo
Python importável. Por isso este harness fala HTTP com o servidor em vez de
chamar uma função diretamente.

Deliberadamente fora do `package.json` e do `requirements.txt` do
AgentService — RAGAS é Python-only (sem porte em TypeScript), e os dois
harnesses avaliam processos diferentes sem código compartilhado que
justifique juntar os dois agora.

## Como rodar

1. Suba o servidor Node (ele precisa estar rodando — este harness não sobe
   o processo sozinho):
   ```
   npm run dev
   ```
   Confirme que `NODE_ENV != production`, senão `/debug/rag-search` não é
   montada (ver `src/server.ts`) e todo caso do dataset falha com 404.

2. Num ambiente Python separado (venv/conda), instale as dependências deste
   harness:
   ```
   pip install -r eval/requirements.txt
   ```

3. Exporte `ANTHROPIC_API_KEY` (o juiz RAGAS chama Claude) e, se o servidor
   não estiver em `http://localhost:3000`, `AGENT_BASE_URL`:
   ```
   export ANTHROPIC_API_KEY=...
   export AGENT_BASE_URL=http://localhost:3000   # opcional, esse é o default
   ```

4. Rode:
   ```
   python -m pytest eval/ -v
   ```

## O que isso mede

Para cada pergunta em `eval_dataset.jsonl`: chama `POST /webhook/web/message`
(a resposta real que o cliente veria) e `GET /debug/rag-search` (os trechos
recuperados crus, sem passar pelo LLM de geração), e pontua as duas métricas
já usadas no curso (Semana 15) e no AgentService irmão:

- **Faithfulness** — a resposta final só afirma coisas presentes no contexto
  recuperado, sem adicionar nada inventado.
- **ContextPrecisionWithoutReference** — o contexto recuperado é
  relevante pra pergunta, sem lixo misturado.

Limiares (`_MIN_FAITHFULNESS = 0.7`, `_MIN_CONTEXT_PRECISION = 0.5`) são os
mesmos do harness irmão — não são 1.0 porque ambas as métricas são um LLM
julgando a saída de outro LLM, com variância real de execução para execução.

## Lição herdada (não descoberta de novo aqui)

Todo `ground_truth` em `eval_dataset.jsonl` corresponde a um fato que
REALMENTE está em `knowledge/catalog.example.json`. Avaliar contra um
corpus que não tem a resposta certa faz toda métrica degenerar pra perto de
zero — parece bug de retrieval, mas é bug de dataset (achado original:
Semana 15 do curso, v1→v2 do dataset).

## Por que não entra no CI padrão

Cada caso chama Claude duas vezes (geração da resposta + juiz RAGAS) — custo
real de API e variância de LLM-como-juiz tornam isso inadequado como gate
automático em todo push. Ver pendência registrada no plano: adicionar como
step manual/`workflow_dispatch`, não bloqueando deploy.
