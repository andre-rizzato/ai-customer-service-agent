# eval/test_rag_quality.py
#
# Gate de qualidade de retrieval para o KnowledgeBase deste repo (Node/TS),
# porta do mesmo harness RAGAS do AgentService irmão
# (DistributedOrderSystem/src/AgentService/tests/rag_eval/test_rag_quality.py),
# adaptado porque aqui o "sistema sob teste" não é um processo Python
# importável - é um servidor Node já rodando. Por isso este harness fala
# HTTP com ele, em vez de chamar uma função direto:
#   - POST /webhook/web/message  -> a resposta final (o que o cliente vê)
#   - GET  /debug/rag-search     -> os trechos recuperados crus (rota só de
#     dev, não montada quando NODE_ENV=production - ver server.ts)
#
# Pré-requisito: o servidor Node precisa estar rodando antes de executar
# este arquivo (npm run dev, ou npm start com NODE_ENV != production) -
# este harness NÃO sobe o processo sozinho, pelo mesmo motivo de
# simplicidade de qualquer teste de integração contra um servidor externo:
# subir/derrubar o processo Node de dentro do pytest adicionaria gestão de
# subprocesso e healthcheck só para este arquivo, sem necessidade real por
# enquanto (uso é sempre manual/CI, nunca em paralelo a outro teste).
#
# Lição herdada do harness irmão (aplicada aqui desde a v1, não descoberta
# de novo): cada ground_truth em eval_dataset.jsonl precisa ser uma resposta
# que REALMENTE existe em knowledge/catalog.example.json - avaliar contra um
# corpus que não tem a resposta faz toda métrica degenerar para perto de
# zero, o que parece bug de retrieval mas é bug de dataset.
#
# Rodar: python -m pytest eval/ -v  (depois de `npm run dev` noutro terminal)

import asyncio
import json
import os
from pathlib import Path

import pytest
import requests
from anthropic import Anthropic
from dotenv import load_dotenv
from ragas.llms.base import llm_factory
from ragas.metrics.collections import ContextPrecisionWithoutReference, Faithfulness

load_dotenv()

# Base URL do servidor Node já rodando - configurável porque CI e uso local
# podem apontar pra endereços diferentes (localhost:3000 em dev, outra porta
# se PORT estiver setado).
_AGENT_BASE_URL = os.environ.get("AGENT_BASE_URL", "http://localhost:3000")
_EVAL_DATASET_PATH = Path(__file__).parent / "eval_dataset.jsonl"

# Mesmo achado documentado no harness irmão: a versão do SDK anthropic
# resolvida aqui (pinada em requirements.txt) não aceita mais `temperature`
# nem `top_p` em Messages.create() - ragas's InstructorModelArgs manda os
# dois por padrão. model_args é um dict comum na instância, seguro de
# mutar depois de construída.
_ragas_llm = llm_factory("claude-sonnet-4-6", provider="anthropic", client=Anthropic())
_ragas_llm.model_args.pop("top_p", None)
_ragas_llm.model_args.pop("temperature", None)

_faithfulness = Faithfulness(llm=_ragas_llm)
_context_precision = ContextPrecisionWithoutReference(llm=_ragas_llm)

# Mesmos limiares do harness irmão - não 1.0 porque as duas métricas são um
# LLM julgando a saída de outro LLM, com variância real de execução pra
# execução.
_MIN_FAITHFULNESS = 0.7
_MIN_CONTEXT_PRECISION = 0.5


def _load_eval_dataset() -> list[dict]:
    with _EVAL_DATASET_PATH.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


# Carregado uma vez, no nível do módulo, e pareado com o índice aqui -
# evita que cada execução de teste tenha que reabrir e refazer uma busca
# linear no arquivo só para descobrir seu próprio índice (ver _run_pipeline).
_EVAL_CASES = list(enumerate(_load_eval_dataset()))


def _run_pipeline(case: dict, case_index: int) -> tuple[str, list[str]]:
    """
    Chama o servidor Node real por HTTP e devolve (reply, retrieved_texts) -
    as duas coisas que RAGAS precisa para pontuar Faithfulness e Context
    Precision. conversationId único por caso evita qualquer colisão com o
    rate limiter (orchestrator/rateLimiter.ts, chave por conversationId) se
    os casos rodarem em sequência rápida.
    """
    conversation_id = f"rag-eval-{case_index}"

    message_response = requests.post(
        f"{_AGENT_BASE_URL}/webhook/web/message",
        json={"conversationId": conversation_id, "text": case["question"]},
        timeout=30,
    )
    message_response.raise_for_status()
    reply = message_response.json()["reply"]

    search_response = requests.get(
        f"{_AGENT_BASE_URL}/debug/rag-search",
        params={"q": case["question"]},
        timeout=30,
    )
    search_response.raise_for_status()
    retrieved_texts = [item["content"] for item in search_response.json()["results"]]

    return reply, retrieved_texts


@pytest.mark.parametrize("case_index,case", _EVAL_CASES, ids=lambda x: x if isinstance(x, int) else x["question"][:40])
def test_faithfulness_and_context_precision(case_index, case):
    reply, retrieved_texts = _run_pipeline(case, case_index)

    # Contexto vazio aqui sempre indica um problema real - toda pergunta do
    # dataset é sobre um item público do catálogo de exemplo, nenhuma
    # exige identidade/telefone (este produto não tem o equivalente à
    # guarda de privacidade do AgentService irmão para este catálogo).
    assert retrieved_texts, f"Nenhum contexto recuperado para: {case['question']!r}"

    faithfulness_value = asyncio.run(
        _faithfulness.ascore(user_input=case["question"], response=reply, retrieved_contexts=retrieved_texts)
    ).value
    precision_value = asyncio.run(
        _context_precision.ascore(user_input=case["question"], response=reply, retrieved_contexts=retrieved_texts)
    ).value

    print(f"\n  question={case['question']!r}")
    print(f"  faithfulness={faithfulness_value:.4f}  context_precision={precision_value:.4f}")

    assert faithfulness_value >= _MIN_FAITHFULNESS
    assert precision_value >= _MIN_CONTEXT_PRECISION
