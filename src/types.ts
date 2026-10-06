// Tipos compartilhados por todo o projeto: canais, orquestrador, base de
// conhecimento e histórico de conversa importam daqui para não duplicar
// definições e para garantir que todo módulo "fale a mesma língua" de dados.

// Nomes dos canais suportados. É um union type (não enum) porque cada
// adapter (Telegram, WhatsApp, Web) só precisa declarar sua própria string
// literal — o TypeScript garante em tempo de compilação que ninguém digite
// "telegran" errado em algum lugar do código.
export type ChannelName = "telegram" | "whatsapp" | "web";

// Formato normalizado de UMA mensagem recebida, depois que o adapter do
// canal (ex.: src/channels/telegram.ts) já traduziu o payload específico
// daquela plataforma para este formato comum. É o que o Orchestrator
// consome — ele nunca sabe se a mensagem veio do Telegram ou do WhatsApp.
export interface InboundMessage {
  // Qual adapter recebeu a mensagem; usado só para log/depuração, a lógica
  // de negócio não ramifica por canal.
  channel: ChannelName;
  // Identificador estável do usuário final naquele canal (número de telefone
  // no WhatsApp, chat id no Telegram). Guardado separado de conversationId
  // porque em tese um canal poderia ter múltiplas conversas por usuário.
  userId: string;
  // Chave usada para agrupar o histórico e rotear a resposta de volta.
  // Hoje é igual a userId em todos os adapters, mas é um campo próprio para
  // não acoplar "identidade do usuário" a "identidade da conversa".
  conversationId: string;
  // Texto puro digitado pelo usuário. Mensagens sem texto (figurinha, áudio,
  // imagem) são descartadas antes de chegar aqui — ver each adapter.
  text: string;
  // Momento em que a mensagem foi enviada, em milissegundos desde epoch.
  // Vem do próprio payload da plataforma quando disponível (Telegram/WhatsApp
  // mandam segundos, por isso os adapters multiplicam por 1000).
  timestamp: number;
}

// Formato de UMA mensagem de saída. Hoje só carrega o texto porque nenhum
// adapter implementado envia mídia, mas o campo conversationId já isola
// "para onde responder" de "quem disse o quê" (ver ConversationTurn).
export interface OutboundMessage {
  conversationId: string;
  text: string;
}

// Um turno de conversa, como fica gravado no histórico (ver
// src/conversation/store.ts) e no log de auditoria (Fase 6/7 do runbook:
// "log de todas as conversas, com timestamp e trecho de contexto usado").
export interface ConversationTurn {
  // "user" = mensagem do cliente; "assistant" = resposta do LLM;
  // "system-note" = anotação interna do orquestrador (ex.: "handoff
  // acionado") que NÃO deve ser reenviada ao LLM como se fosse fala humana
  // (ver o filtro em orchestrator.ts que remove "system-note" do histórico
  // antes de montar o prompt). "human-agent" = resposta escrita por um
  // atendente humano durante um handoff (relay — ver src/handoff/relay.ts):
  // é um papel próprio, e não "assistant", porque (a) o log de auditoria
  // precisa distinguir o que o bot gerou do que uma pessoa escreveu, e (b) é
  // por esse papel que o endpoint de polling do widget web
  // (GET /webhook/web/poll) sabe quais turnos entregar ao navegador — ele
  // NUNCA devolve o histórico inteiro, só as falas do atendente. Pro LLM,
  // quando o bot volta a atender, esse turno vira "assistant" (é a mesma
  // "voz" da empresa falando com o cliente).
  role: "user" | "assistant" | "system-note" | "human-agent";
  text: string;
  timestamp: number;
  // Ids dos itens da base de conhecimento (KnowledgeItem.id) que foram
  // injetados no prompt para gerar esta resposta. Existe só em turnos
  // "assistant" e serve exclusivamente para auditoria manual semanal —
  // permite ao humano checar "essa resposta veio de qual trecho da base?".
  contextUsed?: string[];
  // Marca true quando este turno representa um gatilho de handoff que
  // disparou, para facilitar filtrar/contar handoffs ao ler o log depois.
  handoff?: boolean;
  // true quando este turno foi entregue ao cliente FORA de uma resposta
  // direta ao webhook — hoje, a mensagem automática de encerramento de um
  // atendimento humano (ver HumanRelay.close()). Turnos "human-agent" já são
  // sempre entregues assim; este campo existe pra um turno "assistant"
  // (texto automático, não escrito por pessoa) também chegar ao widget web
  // pelo polling (GET /webhook/web/poll), que só devolve turnos relayed ou
  // human-agent.
  relayed?: boolean;
  // true no turno que marca o FIM de um atendimento humano encerrado (ver
  // HumanRelay.close()): o LLM não recebe nada ANTES deste turno — depois de
  // um encerramento, a próxima mensagem é uma conversa nova. Bug de
  // 06/10/2026: sem esse corte, o modelo via no histórico o "sim, pode
  // transferir" de um atendimento JÁ encerrado e transferia de novo na
  // primeira mensagem seguinte ("Nossos serviços"), sem perguntar nada.
  // O histórico completo continua gravado (auditoria e Mini App); o corte
  // vale só pro prompt.
  contextBoundary?: boolean;
}

// Uma linha da base de conhecimento (Fase 3 do runbook: "uma linha por
// produto/serviço/política"). É o que o script de ingest lê do catálogo e
// o que o vector store guarda associado a cada embedding.
export interface KnowledgeItem {
  // Identificador único e estável do item — usado em ConversationTurn.contextUsed
  // para saber qual item alimentou qual resposta, mesmo que o título mude depois.
  id: string;
  title: string;
  // Texto livre com specs, preço, instalação, garantia, FAQ daquele item —
  // é literalmente o que vai para dentro do prompt quando este item é
  // recuperado pela busca (ver promptBuilder.ts).
  content: string;
  // Campos extras opcionais (categoria, SKU etc.) que hoje não são usados
  // pelo pipeline, mas ficam disponíveis para quem quiser filtrar/exibir
  // metadados sem quebrar o formato principal.
  metadata?: Record<string, string>;
}

// Resultado de uma busca no vector store: o item encontrado mais o quão
// parecido ele é da pergunta (0 a 1, cosine similarity). O orquestrador usa
// `score` para aplicar a "regra de vazio" da Fase 3 (descartar resultados
// abaixo de agentConfig.minRelevanceScore).
export interface RetrievedChunk {
  item: KnowledgeItem;
  score: number;
}
