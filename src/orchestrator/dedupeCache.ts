// Cache de deduplicação por ID de mensagem — item #1 da revisão de
// segurança de 04/10/2026 (docs/SECURITY_REVIEW.md). Tanto a Meta quanto o
// Telegram podem reentregar o MESMO evento de webhook mais de uma vez (não
// só por timeout de resposta — qualquer instabilidade de rede do lado
// deles pode causar reenvio), e sem rastrear quais IDs já foram
// processados, cada reentrega roda o pipeline inteiro de novo: resposta
// duplicada pro cliente e custo de API dobrado (embedding + até 3
// chamadas de LLM, por mensagem reentregue).
//
// Em memória, não em disco — mesma decisão do RateLimiter
// (src/orchestrator/rateLimiter.ts) e pelo mesmo motivo: o objetivo aqui é
// só cobrir a janela curta em que uma reentrega pode acontecer (minutos,
// não dias), então "esquecer" tudo se o processo reiniciar é uma perda
// aceitável — uma reentrega bem na hora de um restart é um caso raro
// demais pra justificar persistir isso em disco.
export class DedupeCache {
  // Map de id da mensagem -> timestamp (epoch ms) em que o registro deste
  // id expira. Usar Map em vez de Set porque precisamos saber QUANDO cada
  // entrada deve ser esquecida, não só SE ela existe.
  private readonly seenUntil = new Map<string, number>();

  constructor(
    // Por quanto tempo um id é lembrado depois de visto pela primeira vez
    // — generoso o bastante pra cobrir qualquer janela de reenvio real da
    // Meta/Telegram, sem crescer sem limite em memória.
    private readonly ttlMs: number
  ) {}

  // Preâmbulo: hasSeenAndRecord() é a única operação pública — faz duas
  // coisas numa chamada só (checar E registrar) de propósito, pra não
  // existir uma janela entre "checar se já viu" e "marcar como visto" em
  // que duas mensagens poderiam passar pela checagem ao mesmo tempo (nesse
  // projeto o processamento é sequencial dentro do loop do adapter, então
  // essa corrida não existe hoje, mas a API já nasce segura contra ela).
  // Chamada por cada ChannelAdapter, uma vez por mensagem recebida, ANTES
  // de chamar o Orchestrator.
  hasSeenAndRecord(id: string): boolean {
    // Sweep completo a cada chamada: no volume de mensagens esperado nesta
    // fase (teste, poucos clientes), isso é desprezível — se o volume
    // crescer a ponto de importar, trocar por uma varredura periódica
    // (setInterval) em vez de fazer isso em toda chamada é a otimização
    // óbvia (ver CLAUDE.md: decisão de custo/performance explícita, não
    // prematura).
    const now = Date.now();
    for (const [seenId, expiresAt] of this.seenUntil) {
      if (expiresAt <= now) this.seenUntil.delete(seenId);
    }

    const expiresAt = this.seenUntil.get(id);
    if (expiresAt !== undefined && expiresAt > now) {
      // Já visto, e o registro ainda não expirou — é uma reentrega.
      return true;
    }

    // Primeira vez vendo este id (ou o registro anterior já tinha
    // expirado) — registra agora, com validade de ttlMs a partir deste
    // instante.
    this.seenUntil.set(id, now + this.ttlMs);
    return false;
  }
}
