// Roteador de capacidades — a generalização do "só handoffKeywords pra
// humano" discutida no Mapa de Capacidades (docs/artifacts/mapa-capacidades.html,
// seção "Decisão · roteamento"): além de decidir SE transfere pra humano
// (handoff.ts), agora decide SE uma mensagem deve pular o RAG e ir direto
// pra um sub-sistema especialista (hoje só "order", via AgentService).
//
// Mesma técnica de handoff.ts de propósito: palavra-chave configurável por
// cliente em agent.config.json, checada ANTES do RAG/LLM — barato,
// determinístico, e ajustável pelo operador sem mexer em prompt.
import { agentConfig } from "../config.js";
import { normalize } from "./handoff.js";

// "order" é a única capacidade com um backend de verdade hoje
// (AgentService -> RestOrderBackend/DistributedOrderSystem ou a API de
// pedidos do cliente). "scheduling"/"sales" já aparecem aqui porque o
// capabilityRouter precisa SABER que a pergunta é sobre agenda/venda para
// decidir o que fazer com ela (ver orchestrator.ts) — mas como não existe
// nó de grafo nem conector plugado nelas ainda do lado do Node, a decisão
// certa hoje é cair em handoff pra humano, nunca fingir que resolveu.
export type CapabilityMatch = "order" | "scheduling" | "sales" | null;

// Preâmbulo: detectCapability() espelha detectHandoffTrigger() em formato e
// propósito — chamada uma vez por mensagem, logo depois do gatilho de
// handoff e antes do RAG. Só considera uma capacidade se ela estiver em
// agentConfig.enabledCapabilities (a "tela de configuração por cliente" do
// design doc) E a lista de keywords correspondente não estiver vazia —
// assim um cliente sem "order" contratado nunca tem mensagem nenhuma
// desviada do RAG por engano.
export function detectCapability(userText: string): CapabilityMatch {
  const normalized = normalize(userText);

  if (agentConfig.enabledCapabilities.includes("order")) {
    for (const keyword of agentConfig.orderKeywords) {
      if (normalized.includes(normalize(keyword))) return "order";
    }
  }
  if (agentConfig.enabledCapabilities.includes("scheduling")) {
    for (const keyword of agentConfig.schedulingKeywords) {
      if (normalized.includes(normalize(keyword))) return "scheduling";
    }
  }
  if (agentConfig.enabledCapabilities.includes("sales")) {
    for (const keyword of agentConfig.salesKeywords) {
      if (normalized.includes(normalize(keyword))) return "sales";
    }
  }
  return null;
}
