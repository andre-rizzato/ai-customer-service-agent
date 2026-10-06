// Monta o system prompt enviado ao LLM a cada mensagem — a Fase 4 do
// runbook chama isso de "o contrato de comportamento". As três regras fixas
// abaixo são mantidas propositalmente em espírito idêntico ao texto
// original do runbook (Fase 4), e o prompt é escrito de forma
// deliberadamente agnóstica de canal (nenhuma menção a WhatsApp/Telegram) —
// assim o mesmo prompt funciona sem alteração por trás de qualquer
// ChannelAdapter.
import { agentConfig } from "../config.js";
import type { Language, RetrievedChunk } from "../types.js";
import { LANGUAGE_NAME } from "./messages.js";
import { HANDOFF_SIGNAL } from "./handoff.js";

// Preâmbulo: buildSystemPrompt() recebe os trechos já recuperados e
// filtrados pela KnowledgeBase (ver knowledgeBase.ts — já passaram pelo
// corte de relevância mínima) e devolve a string completa de system prompt.
// Chamada pelo Orchestrator uma vez por mensagem, depois de confirmar que
// não houve gatilho de handoff.
//
// `language` (06/10/2026): idioma do cliente informado pelo canal. Sem ele,
// o modelo respondia sempre em português — o prompt e a base de
// conhecimento são em português, e ele seguia o idioma do contexto em vez
// do idioma do cliente (bug: as versões em inglês e italiano do site
// recebiam resposta em português).
export function buildSystemPrompt(retrieved: RetrievedChunk[], language?: Language): string {
  // Instrução de idioma: explícita quando o canal informou; quando não
  // informou (ex.: WhatsApp), manda seguir o idioma da mensagem do cliente.
  // Nos dois casos, avisa que o contexto pode estar em outro idioma — senão
  // o modelo tende a copiar o idioma dos trechos recuperados.
  const languageRule = language
    ? `Responda SEMPRE em ${LANGUAGE_NAME[language]}, mesmo que o contexto abaixo esteja em outro idioma (traduza as informações do contexto).`
    : "Responda no mesmo idioma em que o cliente escreveu a última mensagem, mesmo que o contexto abaixo esteja em outro idioma (traduza as informações do contexto).";
  // Monta o bloco de "contexto recuperado da base": se houver trechos
  // relevantes, lista cada um como "- Título: conteúdo"; se a busca não
  // encontrou nada acima do corte de relevância (regra de vazio da Fase 3),
  // escreve uma frase explícita dizendo isso — é essa frase explícita que
  // permite à regra fixa nº 1 abaixo instruir o modelo a admitir que não
  // sabe, em vez de o modelo receber um bloco de contexto vazio/ambíguo e
  // tentar preencher a lacuna sozinho.
  const context =
    retrieved.length > 0
      ? retrieved.map((c) => `- ${c.item.title}: ${c.item.content}`).join("\n")
      : "(nenhum trecho relevante encontrado na base de conhecimento para esta pergunta)";

  // Template literal com o prompt completo. `agentConfig.businessName` e
  // `agentConfig.toneAdjectives` vêm de config/agent.config.json (Fase 0:
  // definidos por negócio, antes de qualquer linha de código); `context` é
  // o bloco montado acima.
  return `Você é o assistente virtual de ${agentConfig.businessName}.

REGRAS FIXAS (nunca quebrar):
1. Responda SOMENTE com base no trecho de contexto fornecido abaixo.
   Se a informação não estiver lá, diga isso claramente e ofereça
   transferir para um atendente humano. Nunca invente specs, preços,
   prazos OU STATUS DE PEDIDO — status de pedido é um dado em tempo
   real que vem sempre do AgentService (ver capabilityRouter.ts),
   nunca da base de conhecimento estática; se uma pergunta sobre
   status de pedido chegar até aqui (ou seja, sem ter sido capturada
   pelo roteador de capacidade antes), isso é um sinal de que o
   roteador falhou em classificá-la — a resposta certa é admitir que
   não tem o dado em mãos e oferecer transferência, nunca supor ou
   inventar um status.
2. Se perguntarem se você é humano ou IA, responda com transparência
   total: "Sou um assistente virtual de ${agentConfig.businessName}."
3. Transfira para humano imediatamente SOMENTE se: (a) o cliente pedir
   explicitamente pra falar com uma pessoa, (b) o cliente responder
   "sim"/"pode"/"pode transferir" a uma oferta de transferência feita
   na SUA MENSAGEM IMEDIATAMENTE ANTERIOR (uma oferta mais antiga, ou de
   um atendimento que já terminou, não vale), ou (c) houver sinal de
   reclamação ou frustração.
   Se você só não encontrou a informação no contexto (inclusive em
   perguntas genéricas como "nossos serviços"), NÃO transfira: diga que
   não tem o detalhe e OFEREÇA a transferência, esperando o cliente
   responder.
   COMO TRANSFERIR: responda APENAS com ${HANDOFF_SIGNAL} — sem nenhum
   outro texto. O sistema faz a transferência e avisa o cliente. NUNCA
   escreva que está transferindo ("vou te transferir", "estou
   conectando você") sem usar ${HANDOFF_SIGNAL}: sem ele, a transferência
   NÃO acontece e o cliente fica esperando alguém que não vem.
   Para OFERECER a transferência (sem fazer), pergunte se o cliente quer.

IDIOMA: ${languageRule}

TOM: ${agentConfig.toneAdjectives.join(", ")}

CONTEXTO RECUPERADO DA BASE:
${context}

Responda à última mensagem do cliente.`;
  // Nota: a regra 3 acima é reforçada (não substituída) pelo detector de
  // handoff em handoff.ts, que roda ANTES desta função ser chamada — a
  // regra escrita no prompt é uma segunda camada de segurança para os casos
  // que o detector por palavra-chave não pegar (ex.: frustração implícita
  // sem usar nenhuma das palavras da lista configurada, ou o cliente
  // aceitando uma oferta de transferência).
  //
  // Até 06/10/2026 essa "segunda camada" não existia de fato: o modelo era
  // instruído a transferir mas não tinha COMO — só escrevia "vou te
  // transferir" e nada acontecia (bug reportado pelo usuário). Agora o
  // modelo responde HANDOFF_SIGNAL e o Orchestrator executa o handoff
  // (detectAssistantHandoff em handoff.ts, com rede de segurança pra quando
  // ele afirma transferir sem o sinal).
}
