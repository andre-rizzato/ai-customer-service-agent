// Detector de gatilhos de handoff — a parte do pipeline (Fase 1 do runbook,
// diagrama "Fluxo de uma mensagem") que decide, ANTES de gastar uma
// chamada de RAG + LLM, se a conversa deve ser transferida direto para um
// humano. É baseado em palavra-chave de propósito: mais barato e mais
// previsível do que pedir para o próprio modelo decidir isso, e mais fácil
// de o operador ajustar (Fase 7: "se está transferindo demais/de menos,
// ajuste o gatilho") sem precisar mexer no prompt nem re-treinar nada.
import { agentConfig } from "../config.js";

// Motivo do handoff detectado, ou null se nenhum gatilho disparou. Usado
// tanto pelo Orchestrator (para decidir se interrompe o pipeline) quanto
// pelo HandoffNotifier (para incluir o motivo na notificação ao humano).
export type HandoffReason = "explicit_request" | "frustration" | null;

// Regex que casa qualquer caractere na faixa Unicode dos "diacríticos
// combinantes" (acentos, til, cedilha etc. quando representados como
// marca separada do caractere-base) — usada para remover acentos depois de
// decompor o texto (ver normalize() abaixo). Definida uma única vez no
// escopo do módulo (não recriada a cada chamada) por eficiência: construir
// um RegExp tem um custo pequeno, mas desnecessário de repetir por mensagem.
const DIACRITICS_PATTERN = new RegExp("[̀-ͯ]", "g");

// Preâmbulo: normalize() prepara um texto para comparação "tolerante" —
// caixa baixa e sem acento — para que o gatilho dispare tanto com "não
// aguento" quanto "nao aguento", "NÃO AGUENTO" etc. Chamada tanto para o
// texto do usuário quanto para cada palavra-chave configurada, garantindo
// que os dois lados da comparação passem pelo mesmo tratamento.
function normalize(text: string): string {
  // toLowerCase(): remove diferença de maiúsculas/minúsculas.
  // normalize("NFD"): decompõe caracteres acentuados em "letra base +
  // marca de acento separada" (ex.: "ã" vira "a" + til combinante) — é essa
  // decomposição que permite ao passo seguinte remover só a marca de acento.
  // replace(DIACRITICS_PATTERN, ""): apaga as marcas de acento já separadas,
  // deixando só as letras base.
  return text.toLowerCase().normalize("NFD").replace(DIACRITICS_PATTERN, "");
}

// Preâmbulo: detectHandoffTrigger() é a função pública deste módulo,
// chamada pelo Orchestrator uma vez por mensagem recebida, logo depois do
// rate limiter e ANTES da busca no RAG — é o ponto do pipeline descrito no
// diagrama da Fase 1 ("Gatilho de handoff? -> Sim -> transfere / Não ->
// busca na base"). Percorre as duas listas configuráveis em
// agent.config.json e devolve o primeiro tipo de gatilho que encontrar.
export function detectHandoffTrigger(userText: string): HandoffReason {
  // Normaliza o texto do usuário uma única vez (fora dos loops abaixo) para
  // não repetir o trabalho de normalização a cada palavra-chave comparada.
  const normalized = normalize(userText);

  // Primeiro checa pedidos explícitos de atendimento humano — lista vem de
  // agentConfig.handoffKeywords (ex.: "falar com atendente", "quero
  // cancelar"). .includes() faz correspondência de substring, então a
  // palavra-chave não precisa ser a mensagem inteira nem estar isolada por
  // espaços — "quero falar com atendente por favor" ainda casa com "falar
  // com atendente".
  for (const keyword of agentConfig.handoffKeywords) {
    if (normalized.includes(normalize(keyword))) return "explicit_request";
  }
  // Se nenhum pedido explícito foi encontrado, checa sinais de frustração —
  // lista vem de agentConfig.frustrationKeywords (ex.: "péssimo",
  // "horrível"). A ordem importa: pedido explícito tem prioridade sobre
  // frustração caso a mensagem contenha as duas coisas.
  for (const keyword of agentConfig.frustrationKeywords) {
    if (normalized.includes(normalize(keyword))) return "frustration";
  }
  // Nenhum gatilho encontrado — o Orchestrator segue o fluxo normal
  // (busca no RAG + chamada ao LLM).
  return null;
}
