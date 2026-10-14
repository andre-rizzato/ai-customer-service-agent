// Verificação de Firebase App Check pro canal web (widget embarcável no
// site institucional — 13/10/2026). Hoje o único freio no
// `POST /webhook/web/message` é o rate limit por IP (`webIpRateLimit` em
// src/server.ts), que só age DEPOIS que a requisição já chegou e que um
// atacante distribuído (muitos IPs) contorna. App Check acrescenta uma
// camada ANTES: o navegador do visitante precisa provar, via reCAPTCHA v3
// (invisível — sem checkbox, sem fricção pro usuário real), que "parece" um
// navegador de verdade; o resultado disso é um token assinado pelo Google
// que o widget manda no header `X-Firebase-AppCheck`, e que este arquivo
// valida.
//
// Mesmo raciocínio de src/admin/firebaseAuth.ts (ID tokens de login): um
// JWT RS256 verificado "na mão" com node:crypto, sem o pacote
// firebase-admin, pra não pesar a VM de 892MB (ver CLAUDE.md, eixo
// "overhead de recurso"). São arquivos SEPARADOS, não uma função a mais
// naquele, porque App Check tem seu PRÓPRIO endpoint de chaves públicas
// (diferente do de login) e suas próprias claims (aud/iss usam o NÚMERO do
// projeto Firebase, não o project id usado pra login) — misturar os dois
// deixaria as constantes e os comentários confusos sobre qual token é qual.
//
// Fonte das claims/endpoint: documentação oficial "Verify App Check tokens
// on your own backend" (firebase.google.com/docs/app-check/custom-resource-backend),
// confirmada nesta sessão via WebFetch antes de escrever este arquivo — não
// exercitado contra um token de verdade (nenhum projeto com App Check
// habilitado ainda nesta sessão); confirme contra um token real antes de
// depender disto em produção.
import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

// Endpoint de chaves públicas do App Check — DIFERENTE do endpoint de ID
// tokens (GOOGLE_JWKS_URL em firebaseAuth.ts). Confundir os dois faria toda
// verificação falhar (chaves de um produto não assinam tokens do outro).
const APP_CHECK_JWKS_URL = "https://firebaseappcheck.googleapis.com/v1/jwks";

// Mesma tolerância de relógio que firebaseAuth.ts usa, pelo mesmo motivo
// (um token recém-emitido não deve ser recusado por o relógio desta VM
// estar alguns segundos atrasado).
const CLOCK_SKEW_SECONDS = 60;

// Mapa kid -> chave pública, mesmo formato de KeyFetcher em
// firebaseAuth.ts — função injetável pra testes usarem uma chave gerada
// localmente em vez de bater na rede.
export type AppCheckKeyFetcher = (forceRefresh: boolean) => Promise<Record<string, JsonWebKey>>;

// Cache em memória, mesmo padrão de firebaseAuth.ts — evita uma requisição
// HTTP nova a cada mensagem do widget. Variável PRÓPRIA (não compartilhada
// com o cache de firebaseAuth.ts): são conjuntos de chaves de endpoints
// diferentes, nunca intercambiáveis.
let cachedKeys: { keys: Record<string, JsonWebKey>; expiresAt: number } | null = null;

// Preâmbulo: fetchAppCheckKeys() é o AppCheckKeyFetcher de produção — mesma
// lógica de cache/forceRefresh que fetchGoogleKeys() em firebaseAuth.ts,
// só apontando pro endpoint do App Check.
export const fetchAppCheckKeys: AppCheckKeyFetcher = async (forceRefresh) => {
  if (!forceRefresh && cachedKeys && Date.now() < cachedKeys.expiresAt) return cachedKeys.keys;
  const res = await fetch(APP_CHECK_JWKS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Falha ao buscar chaves públicas do App Check (${res.status})`);
  const body = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
  cachedKeys = {
    keys: Object.fromEntries(body.keys.map((key) => [key.kid, key])),
    expiresAt: Date.now() + maxAge * 1000,
  };
  return cachedKeys.keys;
};

// Preâmbulo: decodeSegment() é uma cópia literal da função homônima em
// firebaseAuth.ts — decodifica um segmento base64url de JWT pra objeto.
// Duplicada (em vez de importada de lá) de propósito: são dois arquivos
// pensados pra poderem evoluir sem acoplamento, e a função é trivial o
// bastante (3 linhas) pra duplicação não custar nada em manutenção.
function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf-8"));
}

// Preâmbulo: verifyAppCheckToken() devolve true se o token for um App
// Check token válido pro projeto `projectNumber`, false pra qualquer
// checagem que falhe. Nunca lança por token ruim — só se não conseguir
// buscar as chaves do Google (quem chama decide o que fazer com isso, ver
// appCheckMiddleware() em src/server.ts).
//
// Diferente de verifyFirebaseIdToken() (que devolve a identidade pra
// decisões de autorização mais ricas), aqui o resultado é só sim/não — o
// App Check não autentica QUEM é o visitante, só ATESTA que o cliente que
// está chamando parece ser o app de verdade rodando num navegador real.
// Não há "identidade" nenhuma pra extrair do token além disso.
export async function verifyAppCheckToken(
  token: string,
  projectNumber: string,
  getKeys: AppCheckKeyFetcher = fetchAppCheckKeys,
  nowMs: number = Date.now()
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeSegment(headerB64);
    payload = decodeSegment(payloadB64);
  } catch {
    return false;
  }

  // Mesma defesa contra "alg: none"/HS256 que verifyFirebaseIdToken() já
  // aplica — aceitar o alg que o próprio token declara é a falha clássica
  // de JWT.
  if (header.alg !== "RS256" || typeof header.kid !== "string") return false;

  let keys = await getKeys(false);
  if (!keys[header.kid]) keys = await getKeys(true);
  const jwk = keys[header.kid];
  if (!jwk) return false;

  const signedData = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = Buffer.from(signatureB64, "base64url");
  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  if (!verify("RSA-SHA256", signedData, publicKey, signature)) return false;

  const now = nowMs / 1000;
  if (typeof payload.exp !== "number" || payload.exp <= now - CLOCK_SKEW_SECONDS) return false;
  if (typeof payload.iat !== "number" || payload.iat > now + CLOCK_SKEW_SECONDS) return false;

  // iss/aud amarram o token ao NOSSO projeto — igual verifyFirebaseIdToken(),
  // só que com o NÚMERO do projeto (ex.: "896501484372"), não o project id
  // ("rizzato-tech"). São valores diferentes do mesmo projeto Firebase; usar
  // o project id aqui por engano faria TODO token válido ser recusado.
  if (payload.iss !== `https://firebaseappcheck.googleapis.com/${projectNumber}`) return false;
  // aud vem como array (pode ter mais de um projeto associado ao mesmo app,
  // em teoria) — basta UM dos valores bater com o nosso.
  const audience = Array.isArray(payload.aud) ? payload.aud : [];
  if (!audience.includes(`projects/${projectNumber}`)) return false;

  return true;
}
