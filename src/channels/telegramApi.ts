// Cliente mínimo da Telegram Bot API — um único ponto que sabe montar a URL
// "https://api.telegram.org/bot<TOKEN>/<método>" e tratar a resposta.
// Extraído em 05/10/2026 quando o relay de handoff (src/handoff/) passou a
// precisar de outros métodos além de sendMessage (answerCallbackQuery,
// sendMessage com teclado inline): sem este helper, TelegramAdapter,
// TelegramNotifier e TelegramDesk repetiriam cada um o mesmo fetch + checagem
// de erro, e uma correção (ex.: timeout) teria que ser feita em três lugares.

// Preâmbulo: callTelegram() faz um POST JSON para um método da Bot API e
// devolve `true` se o Telegram aceitou (HTTP 2xx), `false` caso contrário.
// NUNCA lança em erro HTTP — mesmo padrão dos outros clients do projeto
// (ver TelegramAdapter.sendMessage, WhatsAppAdapter.sendMessage): uma falha
// de envio é logada e quem chamou decide o que fazer com o booleano (o relay,
// por exemplo, avisa o atendente que a mensagem não chegou ao cliente, em vez
// de dizer "enviado" por engano). Só falha de REDE (fetch rejeitado) ainda
// propagaria — por isso o try/catch também cobre esse caso e devolve false.
export async function callTelegram(botToken: string, method: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Timeout explícito: sem ele, uma API do Telegram lenta seguraria a
      // requisição do cliente (ex.: o POST do widget web esperando o
      // Orchestrator, que espera o notifier) por tempo indefinido. 10s é
      // folgado pra uma chamada que normalmente leva ~200ms.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`Telegram ${method} failed (${res.status}): ${await res.text().catch(() => "")}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Telegram ${method} failed (network):`, err);
    return false;
  }
}
