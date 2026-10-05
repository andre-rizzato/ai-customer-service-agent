// Limitador de taxa por conversa — item do checklist da Fase 6 do runbook:
// "Limite de taxa configurado no orquestrador para evitar custo
// descontrolado em caso de mensagens em loop." Implementação de janela fixa
// (fixed window), a mais simples possível: conta mensagens por
// conversationId dentro de uma janela de tempo e reseta quando a janela
// expira.

// Preâmbulo: RateLimiter guarda, em memória, um contador por conversa mais
// o instante em que a janela atual começou. Instanciado uma vez pelo
// Orchestrator com os limites vindos de agent.config.json.
export class RateLimiter {
  // Map de conversationId -> { count, windowStart }. Fica só em memória
  // (não persiste em disco) porque um rate limit não precisa sobreviver a
  // um restart do processo — é aceitável "esquecer" a contagem se o
  // servidor reiniciar.
  private readonly windows = new Map<string, { count: number; windowStart: number }>();

  constructor(
    // Quantas mensagens uma mesma conversa pode mandar dentro de uma janela
    // antes de ser bloqueada.
    private maxMessagesPerWindow: number,
    // Duração da janela, em segundos.
    private windowSeconds: number
  ) {}

  // Preâmbulo: updateLimits() permite ajustar os limites de um RateLimiter
  // já instanciado — chamado por Orchestrator.reloadConfig() depois que a
  // tela de configuração (public/settings.html) salva um novo
  // rateLimit.maxMessagesPerWindow/windowSeconds, sem precisar recriar o
  // RateLimiter (o que perderia as janelas já em andamento de cada
  // conversa). Não limpa `windows` — janelas ativas continuam valendo com
  // os limites antigos até expirar; só a PRÓXIMA janela de cada conversa
  // nasce já com os valores novos, consistente com o próprio desenho de
  // "janela fixa" da classe.
  updateLimits(maxMessagesPerWindow: number, windowSeconds: number): void {
    this.maxMessagesPerWindow = maxMessagesPerWindow;
    this.windowSeconds = windowSeconds;
  }

  // Preâmbulo: isAllowed() é chamado pelo Orchestrator no início do
  // pipeline, antes de qualquer outro processamento (inclusive antes de
  // gravar a mensagem no histórico) — se retornar false, o Orchestrator
  // responde com um aviso de "desacelera" e não gasta nenhuma chamada de
  // API com aquela mensagem.
  isAllowed(conversationId: string): boolean {
    const now = Date.now();
    // Converte a duração da janela de segundos (mais legível na
    // configuração) para milissegundos (unidade usada por Date.now()).
    const windowMs = this.windowSeconds * 1000;
    const entry = this.windows.get(conversationId);

    // Duas situações tratadas como "ainda não há janela válida": (a) esta é
    // a primeira mensagem desta conversa (entry undefined), ou (b) já
    // passou tempo suficiente desde que a janela anterior começou — nos
    // dois casos, começamos uma nova janela do zero, com contagem 1 (a
    // mensagem atual já conta).
    if (!entry || now - entry.windowStart >= windowMs) {
      this.windows.set(conversationId, { count: 1, windowStart: now });
      return true;
    }

    // Ainda dentro da janela atual: se já atingiu o limite configurado,
    // bloqueia sem incrementar o contador (a mensagem bloqueada não deveria
    // "gastar" mais uma vaga).
    if (entry.count >= this.maxMessagesPerWindow) {
      return false;
    }

    // Ainda dentro do limite: incrementa o contador da janela atual e
    // permite a mensagem.
    entry.count++;
    return true;
  }
}
