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

1. **Qdrant com o catálogo de exemplo.** O dataset só faz sentido contra
   `knowledge/catalog.example.json` (ver "Lição herdada" abaixo). Use um
   Qdrant **local**, nunca o de produção: o `npm run ingest` recria a
   coleção.
   - Com Docker: `docker run -p 6333:6333 qdrant/qdrant`.
   - Sem Docker, no Windows: baixe o `qdrant-x86_64-pc-windows-msvc.zip` da
     [página de releases](https://github.com/qdrant/qdrant/releases) e rode o
     `qdrant.exe`. **Use uma pasta de dados com caminho curto** (ex.:
     `%TEMP%\qd-eval`), definindo `QDRANT__STORAGE__STORAGE_PATH` com barras
     invertidas. Num caminho longo, o Qdrant estoura o limite de 260
     caracteres do Windows ao criar as subpastas, e a criação da coleção
     falha com `Gridstore IO error: O sistema não pode encontrar o caminho
     especificado`.

   Depois indexe: `QDRANT_URL=http://localhost:6333 npm run ingest`.

2. **Suba o servidor Node.** O harness não sobe o processo sozinho. Use uma
   porta e pastas de dados próprias, pra não misturar com os seus dados
   locais (ver "Armadilhas do ambiente" no `CLAUDE.md`):
   ```bash
   PORT=3999 QDRANT_URL=http://localhost:6333 TELEGRAM_BOT_TOKEN="111:FAKE" \
   CONVERSATIONS_DIR=/tmp/eval/conv AUDIT_LOG_PATH=/tmp/eval/audit.jsonl \
   USAGE_LOG_PATH=/tmp/eval/usage.jsonl npx tsx src/server.ts
   ```
   - Confirme que `NODE_ENV != production`; senão `/debug/rag-search` não é
     montada (ver `src/server.ts`) e todo caso falha com 404.
   - Use pastas **vazias** a cada execução. Os casos usam ids fixos
     (`rag-eval-0`...), e um histórico de uma execução anterior entraria no
     prompt da seguinte.
   - Ao terminar, derrube o servidor **e o processo pai** (no Windows,
     parar o `tsx` deixa o `node` filho escutando a porta).

3. **Ambiente Python separado.** No Windows, use o launcher `py`, nunca
   `python` (é o atalho da Microsoft Store e fica travado):
   ```bash
   py -3.13 -m venv .venv-eval
   .venv-eval/Scripts/python.exe -m pip install -r eval/requirements.txt pytest
   ```

4. **Rode.** `ANTHROPIC_API_KEY` vem do `.env` (o harness usa `load_dotenv`):
   ```bash
   AGENT_BASE_URL=http://localhost:3999 .venv-eval/Scripts/python.exe -m pytest eval/ -q -s
   ```
   O `-s` mostra a nota de cada caso. São ~7–8 minutos para os 20 casos.

## O que isso mede

Para cada pergunta em `eval_dataset.jsonl`, o harness chama
`POST /webhook/web/message` (a resposta real que o cliente veria) e
`GET /debug/rag-search` (os trechos recuperados crus, sem passar pelo LLM de
geração). Depois pontua as duas métricas já usadas no curso (Semana 15) e no
AgentService irmão:

- **Faithfulness** — a resposta final só afirma coisas presentes no contexto
  recuperado, sem adicionar nada inventado.
- **ContextPrecisionWithoutReference** — o contexto recuperado é
  relevante pra pergunta, sem lixo misturado. É a métrica que mede a
  **busca**. A *faithfulness* mede a **resposta**.

Limiares (`_MIN_FAITHFULNESS = 0.7`, `_MIN_CONTEXT_PRECISION = 0.5`) são os
mesmos do harness irmão — não são 1.0 porque ambas as métricas são um LLM
julgando a saída de outro LLM, com variância real de execução para execução.
Por essa variância, compare **as notas de cada caso** entre duas execuções,
não só o total de aprovados.

O dataset tem 20 perguntas: 8 diretas ("qual o preço do FX200?") e 12
indiretas ou coloquiais ("moro de aluguel e não posso mexer no encanamento,
qual filtro serve pra mim?"). As indiretas existem porque é nelas que o HyDE
faz diferença. Com só perguntas diretas, não dá pra saber se pular o HyDE
custa precisão.

## Histórico de execuções

| Data | Mudança avaliada | Aprovados | Observação |
|---|---|---|---|
| 09/10/2026 | antes do HyDE condicional | 14/20 | 1 falha foi um 500 pontual da Voyage na rota de debug |
| 09/10/2026 | HyDE condicional + cache + janela | 16/20 | *context precision* idêntica nos 20 casos; HyDE rodou em 2/20 |

As falhas que se repetem são de *faithfulness*, e dizem respeito à resposta,
não à busca. Exemplo: "como faço pra acompanhar minha encomenda?" tirou 0,25
e depois 0,20. A resposta acrescenta orientação que não está no catálogo. É
ajuste de prompt (`src/orchestrator/promptBuilder.ts`), não do RAG.

Até 09/10/2026, **o juiz nunca tinha rodado**. O harness passava um cliente
síncrono (`Anthropic()`) para métricas chamadas com `.ascore()`, e o RAGAS
0.4.3 lança `Cannot use agenerate() with a synchronous client` em todo caso.
Corrigido com `AsyncAnthropic` (ver o comentário em `test_rag_quality.py`).

## Custo de uma execução

- **Servidor:** cada caso faz uma mensagem e uma busca de debug. O consumo
  vai para o `USAGE_LOG_PATH` do servidor, e
  `npm run usage:report -- --file <arquivo>` mostra o custo (~US$ 0,04 a
  0,08 por execução com Claude Haiku 4.5).
- **Rota de debug no relatório:** as buscas da rota de debug rodam fora de
  qualquer conversa, então o relatório as conta como "Indexação do
  catálogo".
- **Juiz:** o juiz (Claude Sonnet 4.6, chamado pelo RAGAS) **não** passa
  pelo medidor. Confira no Console da Anthropic.

## Conversa longa (memória)

Este harness só manda perguntas soltas, então não testa a memória da
conversa (janela + resumo + busca nos turnos antigos, ver
`src/conversation/memory.ts`). Para isso existe
`npm run eval:long-conversation` (`scripts/evalLongConversation.ts`). Ele
roda uma conversa de 16 mensagens contra o mesmo servidor e confere se o bot
lembra do nome, do produto indicado e da cidade da cliente. Resultado de
09/10/2026: 3/3, tanto com a janela de 15 turnos quanto com o histórico
completo.

## Teste adversarial (prompt injection e abuso)

`npm run eval:adversarial` (`scripts/evalAdversarial.ts`) usa o mesmo
servidor e o mesmo Qdrant. Ele manda 16 ataques e diz quais o bot resistiu:
preço e desconto falsos, vazar o prompt, falso "SYSTEM", fechar a marca
`<memoria>`, forçar a transferência, injeção que sobrevive no resumo,
mensagem gigante, burla do rate limit, entre outros. Resultado de
09/10/2026: **12/16 antes das proteções, 16/16 depois.** O que cada caso
testa, as proteções e as pendências estão em
[`docs/SEGURANCA_PROMPT_INJECTION.md`](../docs/SEGURANCA_PROMPT_INJECTION.md).

Depois de qualquer mudança nas proteções, rode também as perguntas deste
dataset. Confira no audit log do servidor que nenhuma resposta legítima foi
bloqueada (`system-note` "Checagem de valores"). Em 09/10 foram 0
bloqueios.

## Lição herdada (não descoberta de novo aqui)

Todo `ground_truth` em `eval_dataset.jsonl` corresponde a um fato que
REALMENTE está em `knowledge/catalog.example.json`. Avaliar contra um
corpus que não tem a resposta certa faz toda métrica degenerar pra perto de
zero — parece bug de retrieval, mas é bug de dataset (achado original:
Semana 15 do curso, v1→v2 do dataset).

## Por que não entra no CI padrão

Cada caso chama Claude várias vezes: a resposta, às vezes o HyDE, e o juiz
RAGAS. O custo real de API e a variância de LLM-como-juiz tornam isso
inadequado como gate automático em todo push. Pendência registrada: adicionar
como step manual (`workflow_dispatch`), sem bloquear o deploy.
