// Cliente HTTP para o AgentService (Python/FastAPI, standalone — ver
// DistributedOrderSystem/src/AgentService/main.py). Mesmo raciocínio de
// desenho dos providers de LLM/embeddings: este módulo só conhece o
// contrato HTTP (POST /agent/message -> {reply, intent, confidence,
// order_id}), nunca a implementação do outro lado — o AgentService podia
// trocar de LangGraph pra qualquer outra coisa sem este arquivo mudar uma
// linha.
import { env } from "../config.js";

// Espelha AgentResponse em main.py — só os campos que o Orchestrator
// realmente usa (reply) têm tipo obrigatório; os outros (intent,
// confidence, order_id) são opcionais porque hoje só servem para log/debug,
// não para decisão de fluxo neste lado.
export interface AgentServiceResponse {
  reply: string;
  intent?: string;
  confidence?: number;
  order_id?: string;
}

// Preâmbulo: callAgentService() é chamada pelo Orchestrator quando
// capabilityRouter.ts detecta uma pergunta de pedido E "order" está em
// agentConfig.enabledCapabilities (checagem de AGENT_SERVICE_URL já
// aconteceu na inicialização, em config.ts — aqui ele é garantido existir).
// sessionId é o conversationId do canal — o AgentService usa isso só como
// um identificador opaco de log (session_id em AgentRequest), não precisa
// saber que veio do Telegram/WhatsApp/web.
export async function callAgentService(
  message: string,
  sessionId: string
): Promise<AgentServiceResponse> {
  // env.AGENT_SERVICE_URL é string | undefined no tipo (Zod .optional()),
  // mas a checagem cruzada em config.ts já garante que ele existe sempre
  // que este módulo é chamado — o `!` documenta essa garantia pro
  // TypeScript, que não enxerga a checagem feita num arquivo diferente.
  const res = await fetch(`${env.AGENT_SERVICE_URL!}/agent/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, session_id: sessionId }),
  });

  // Mesmo padrão de tratamento de erro HTTP que voyageEmbeddings.ts já usa:
  // fetch não rejeita em 4xx/5xx, então checamos res.ok manualmente e
  // incluímos o corpo da resposta na mensagem de erro para facilitar debug.
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AgentService request failed (${res.status}): ${body}`);
  }

  return (await res.json()) as AgentServiceResponse;
}
