// Validação do `initData` de um Telegram Mini App (Web App) — é o que
// AUTENTICA o atendente que abre a página public/handoff-app.html de dentro
// do Telegram, sem senha e sem token em link. Quando o Telegram abre um
// Mini App, ele entrega à página uma string `initData` (querystring) com o
// usuário que abriu, a data e um `hash` = HMAC calculado com uma chave
// derivada do TOKEN DO BOT — que só o Telegram e este servidor conhecem.
// Se o HMAC bate, sabemos que (a) a string veio mesmo do Telegram e (b)
// quem abriu foi aquele user.id; depois basta conferir se esse id está na
// allowlist de atendentes (src/handoff/attendants.ts).
//
// Por isso um link do Mini App vazado/encaminhado não serve pra nada: aberto
// fora do Telegram não há initData; aberto no Telegram de outra pessoa, o
// user.id não está na allowlist.
//
// Algoritmo (documentação oficial "Validating data received via the Mini
// App"):
//   secret_key       = HMAC_SHA256(key="WebAppData", msg=bot_token)
//   data_check_string = todos os campos exceto `hash`, "chave=valor",
//                       ordenados por chave, unidos por "\n"
//   hash esperado    = hex(HMAC_SHA256(key=secret_key, msg=data_check_string))
import { createHmac, timingSafeEqual } from "node:crypto";

// Preâmbulo: validateTelegramInitData() devolve o user.id (string) de quem
// abriu o Mini App se o initData for autêntico e recente, ou null em
// qualquer outro caso — quem chama (rota /api/handoff/* em server.ts) só
// precisa saber "é válido e de quem é", sem detalhes do motivo da recusa
// (não vazar pro cliente HTTP qual parte da validação falhou).
//
// `maxAgeSeconds` limita a idade do initData (campo auth_date): sem isso,
// um initData capturado uma vez (ex.: de um log) valeria pra sempre. `nowMs`
// é parâmetro (com default) só pra os testes conseguirem fixar o relógio.
export function validateTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number,
  nowMs: number = Date.now()
): string | null {
  // URLSearchParams já faz o decode de percent-encoding — o
  // data_check_string usa os valores DECODIFICADOS, exatamente como a
  // documentação pede.
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  // Ordenação por comparação simples de string (ordem de code unit), não
  // localeCompare — localeCompare depende do locale do processo e poderia
  // ordenar diferente do que o Telegram usou pra calcular o hash. O campo
  // `signature` (validação Ed25519 pra terceiros, adicionado em 2024) FICA
  // no data_check_string: a regra é "todos exceto hash".
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secretKey).update(dataCheckString).digest();

  // Compara em tempo constante (timingSafeEqual) pra não vazar, pelo tempo
  // de resposta, quantos bytes do hash um atacante acertou. Buffer.from
  // com "hex" de uma string inválida gera um buffer menor — a checagem de
  // tamanho antes evita o throw de timingSafeEqual com tamanhos diferentes.
  const provided = Buffer.from(hash, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  // Idade: auth_date vem em SEGUNDOS desde epoch (padrão Unix).
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || nowMs / 1000 - authDate > maxAgeSeconds) return null;

  // `user` é um JSON serializado dentro da querystring. try/catch porque,
  // mesmo com HMAC válido, não custa nada não confiar cegamente no formato.
  try {
    const user = JSON.parse(params.get("user") ?? "null") as { id?: number } | null;
    return user?.id !== undefined ? String(user.id) : null;
  } catch {
    return null;
  }
}
