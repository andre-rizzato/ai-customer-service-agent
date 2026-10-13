// Testes da autenticação de admin da tela de configuração
// (src/admin/firebaseAuth.ts). Como a verificação do ID token do Firebase é
// feita "na mão" (sem firebase-admin), cada checagem da documentação vira um
// teste: um erro aqui significaria deixar alguém de fora entrar na
// configuração do bot. Os tokens são assinados com um par de chaves RSA gerado
// no próprio teste, injetado no lugar das chaves públicas do Google.
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isAdmin, parseAdminEmails, verifyFirebaseIdToken, type KeyFetcher } from "../src/admin/firebaseAuth.js";

const PROJECT = "rizzatotech-test";
const NOW = 1_760_000_000_000;
const nowSec = Math.floor(NOW / 1000);

// Par de chaves do "Google" de mentira. A pública vai pro KeyFetcher no
// formato JWK, igual ao endpoint real devolve.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid";
const fetcher: KeyFetcher = async () => ({ [KID]: publicKey.export({ format: "jwk" }) });

// Preâmbulo: makeToken() monta e assina um JWT RS256 com claims válidas por
// padrão; cada teste sobrescreve só o que quer quebrar.
function makeToken(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT", ...header })).toString("base64url");
  const p = Buffer.from(
    JSON.stringify({
      aud: PROJECT,
      iss: `https://securetoken.google.com/${PROJECT}`,
      sub: "uid-123",
      iat: nowSec - 10,
      auth_time: nowSec - 10,
      exp: nowSec + 3600,
      email: "Admin@Example.com",
      email_verified: true,
      ...claims,
    })
  ).toString("base64url");
  const s = sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url");
  return `${h}.${p}.${s}`;
}

describe("verifyFirebaseIdToken", () => {
  // Preâmbulo: caminho feliz — token válido devolve a identidade.
  it("aceita um token válido", async () => {
    expect(await verifyFirebaseIdToken(makeToken(), PROJECT, fetcher, NOW)).toEqual({
      uid: "uid-123",
      email: "Admin@Example.com",
      emailVerified: true,
    });
  });

  // Preâmbulo: token de OUTRO projeto Firebase (mesmas chaves do Google!)
  // não pode passar — é por isso que aud/iss existem.
  it("recusa token de outro projeto", async () => {
    expect(await verifyFirebaseIdToken(makeToken({ aud: "outro" }), PROJECT, fetcher, NOW)).toBeNull();
    expect(await verifyFirebaseIdToken(makeToken({ iss: "https://securetoken.google.com/outro" }), PROJECT, fetcher, NOW)).toBeNull();
  });

  // Preâmbulo: token vencido é recusado.
  it("recusa token expirado", async () => {
    expect(await verifyFirebaseIdToken(makeToken({ exp: nowSec - 3600 }), PROJECT, fetcher, NOW)).toBeNull();
  });

  // Preâmbulo: trocar o payload depois de assinado (ex.: pôr o e-mail do
  // admin) invalida a assinatura.
  it("recusa payload adulterado", async () => {
    const [h, , s] = makeToken().split(".");
    const forged = Buffer.from(JSON.stringify({ aud: PROJECT, email: "eu@x.com" })).toString("base64url");
    expect(await verifyFirebaseIdToken(`${h}.${forged}.${s}`, PROJECT, fetcher, NOW)).toBeNull();
  });

  // Preâmbulo: o ataque clássico de JWT — declarar "alg": "none" (ou outro
  // alg) no header. O alg é fixo em RS256, independente do que o token diz.
  it("recusa alg diferente de RS256", async () => {
    expect(await verifyFirebaseIdToken(makeToken({}, { alg: "none" }), PROJECT, fetcher, NOW)).toBeNull();
    expect(await verifyFirebaseIdToken(makeToken({}, { alg: "HS256" }), PROJECT, fetcher, NOW)).toBeNull();
  });

  // Preâmbulo: kid desconhecido força UMA nova busca das chaves (rotação do
  // Google) e, se continuar desconhecido, recusa.
  it("rebusca as chaves com kid desconhecido e recusa se não achar", async () => {
    const spy = vi.fn(fetcher);
    expect(await verifyFirebaseIdToken(makeToken({}, { kid: "rotacionado" }), PROJECT, spy, NOW)).toBeNull();
    expect(spy).toHaveBeenCalledWith(true);
  });

  // Preâmbulo: lixo no lugar do token não lança, só devolve null.
  it("recusa token malformado", async () => {
    expect(await verifyFirebaseIdToken("abc", PROJECT, fetcher, NOW)).toBeNull();
    expect(await verifyFirebaseIdToken("a.b.c", PROJECT, fetcher, NOW)).toBeNull();
  });
});

describe("isAdmin", () => {
  const admins = parseAdminEmails(" admin@example.com , outro@x.com ");

  // Preâmbulo: e-mail na lista e verificado = admin, sem diferenciar
  // maiúsculas.
  it("aceita e-mail verificado da lista", () => {
    expect(isAdmin({ uid: "u", email: "ADMIN@example.com", emailVerified: true }, admins)).toBe(true);
  });

  // Preâmbulo: o motivo do email_verified — qualquer um pode criar uma conta
  // de e-mail/senha com o e-mail do admin; ela só não fica verificada.
  it("recusa e-mail da lista não verificado", () => {
    expect(isAdmin({ uid: "u", email: "admin@example.com", emailVerified: false }, admins)).toBe(false);
  });

  it("recusa e-mail fora da lista ou ausente", () => {
    expect(isAdmin({ uid: "u", email: "eu@x.com", emailVerified: true }, admins)).toBe(false);
    expect(isAdmin({ uid: "u", emailVerified: true }, admins)).toBe(false);
  });
});
