// Autenticação de ADMIN pra tela de configuração (public/settings.html +
// /api/config) usando o MESMO Firebase Authentication do site institucional
// (rizzatotech-site, commit "Add Firebase Authentication"): mesmas contas,
// mesmo login com Google. Motivo (05/10/2026): a tela foi feita como
// ferramenta de debug local, sem autenticação, mas estava acessível em
// produção — qualquer um podia mudar o comportamento do bot ou desligar a
// notificação de handoff.
//
// O navegador faz login com o Firebase JS SDK e manda o ID token (um JWT
// RS256 assinado pelo Google) no header Authorization; aqui validamos esse
// JWT e conferimos se o e-mail é de um admin (ADMIN_EMAILS).
//
// Por que verificar "na mão" em vez de usar o pacote firebase-admin: ele traz
// dezenas de MB de dependências (gRPC, google-auth-library...) e mais memória
// residente num processo que roda numa VM de 892MB (ver CLAUDE.md, eixo
// "overhead de recurso") — tudo isso pra uma operação que são ~50 linhas com
// o `crypto` nativo do Node. O algoritmo segue a documentação oficial
// "Verify ID tokens using a third-party JWT library".
import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

// Chaves públicas (formato JWK) com que o Google assina os ID tokens do
// Firebase. Rotacionam periodicamente — o header Cache-Control da resposta
// diz por quanto tempo cada conjunto vale.
const GOOGLE_JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

// Tolerância de relógio entre esta VM e o Google, em segundos — sem isso, um
// token recém-emitido poderia ser recusado por "iat no futuro" se o relógio
// da VM estiver alguns segundos atrasado.
const CLOCK_SKEW_SECONDS = 60;

// Quem é o usuário, depois de um token válido — só o que a checagem de admin
// precisa.
export interface FirebaseIdentity {
  uid: string;
  email?: string;
  emailVerified: boolean;
}

// Mapa kid -> chave pública. Função injetável (parâmetro de
// verifyFirebaseIdToken) pra os testes usarem uma chave gerada localmente em
// vez de buscar as do Google.
export type KeyFetcher = (forceRefresh: boolean) => Promise<Record<string, JsonWebKey>>;

// Cache em memória das chaves do Google — evita uma requisição HTTP ao Google
// a cada chamada de /api/config. `expiresAt` vem do max-age da resposta.
let cachedKeys: { keys: Record<string, JsonWebKey>; expiresAt: number } | null = null;

// Preâmbulo: fetchGoogleKeys() é o KeyFetcher de produção. Usa o cache
// enquanto ele vale; `forceRefresh` é usado quando o token traz um `kid` que
// não está no cache (o Google rotacionou as chaves antes do max-age vencer).
export const fetchGoogleKeys: KeyFetcher = async (forceRefresh) => {
  if (!forceRefresh && cachedKeys && Date.now() < cachedKeys.expiresAt) return cachedKeys.keys;
  const res = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Falha ao buscar chaves públicas do Firebase (${res.status})`);
  const body = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
  // max-age em segundos; sem o header, 1h é um valor seguro (o Google
  // costuma mandar ~6h).
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
  cachedKeys = {
    keys: Object.fromEntries(body.keys.map((key) => [key.kid, key])),
    expiresAt: Date.now() + maxAge * 1000,
  };
  return cachedKeys.keys;
};

// Preâmbulo: decodeSegment() decodifica uma parte base64url de um JWT pra
// objeto. try/catch fica em quem chama — um token malformado vira "inválido".
function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf-8"));
}

// Preâmbulo: verifyFirebaseIdToken() devolve a identidade de um ID token do
// Firebase válido pro projeto `projectId`, ou null se qualquer checagem
// falhar. Nunca lança por token ruim — só se não conseguir buscar as chaves
// do Google (aí quem chama responde 503, não 401: não é culpa do usuário).
//
// Checagens, na ordem da documentação: header (alg RS256 + kid conhecido),
// assinatura, e as claims exp/iat/auth_time/aud/iss/sub.
export async function verifyFirebaseIdToken(
  token: string,
  projectId: string,
  getKeys: KeyFetcher = fetchGoogleKeys,
  nowMs: number = Date.now()
): Promise<FirebaseIdentity | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeSegment(headerB64);
    payload = decodeSegment(payloadB64);
  } catch {
    return null;
  }

  // alg fixo em RS256: aceitar o alg que o próprio token declara é a falha
  // clássica de JWT ("alg": "none", ou HS256 usando a chave pública como
  // segredo HMAC).
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

  // kid desconhecido: tenta uma vez buscar as chaves de novo (rotação).
  let keys = await getKeys(false);
  if (!keys[header.kid]) keys = await getKeys(true);
  const jwk = keys[header.kid];
  if (!jwk) return null;

  // Assinatura RS256 = RSA PKCS#1 v1.5 com SHA-256 sobre "header.payload".
  const signedData = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = Buffer.from(signatureB64, "base64url");
  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  if (!verify("RSA-SHA256", signedData, publicKey, signature)) return null;

  const now = nowMs / 1000;
  // Claims de tempo: exp no futuro; iat e auth_time não no futuro (com
  // tolerância de relógio).
  if (typeof payload.exp !== "number" || payload.exp <= now - CLOCK_SKEW_SECONDS) return null;
  if (typeof payload.iat !== "number" || payload.iat > now + CLOCK_SKEW_SECONDS) return null;
  if (typeof payload.auth_time !== "number" || payload.auth_time > now + CLOCK_SKEW_SECONDS) return null;
  // aud/iss amarram o token ao NOSSO projeto Firebase — sem isso, um token
  // de qualquer outro app Firebase do mundo (assinado pelas mesmas chaves do
  // Google) passaria.
  if (payload.aud !== projectId) return null;
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null;
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;

  return {
    uid: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    emailVerified: payload.email_verified === true,
  };
}

// Preâmbulo: parseAdminEmails() transforma ADMIN_EMAILS ("a@x.com, b@y.com")
// num Set em minúsculas — e-mail é comparado sem diferenciar maiúsculas.
export function parseAdminEmails(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

// Preâmbulo: isAdmin() decide se uma identidade válida é admin. Exige
// email_verified: com login por e-mail/senha, o Firebase deixa qualquer um
// criar uma conta com QUALQUER e-mail (inclusive o seu) — só não marca como
// verificado. Sem esta checagem, bastaria alguém se cadastrar no site com o
// e-mail do admin. Login com Google já vem verificado.
export function isAdmin(identity: FirebaseIdentity, adminEmails: Set<string>): boolean {
  return identity.emailVerified && !!identity.email && adminEmails.has(identity.email.toLowerCase());
}
