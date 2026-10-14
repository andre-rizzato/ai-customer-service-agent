// Testes de verifyAppCheckToken (src/admin/appCheck.ts) — mesmo padrão de
// tests/firebaseAuth.test.ts: assina tokens com um par de chaves RSA gerado
// no próprio teste, no lugar das chaves públicas do Google. Claims
// diferentes das de login (aud/iss usam o NÚMERO do projeto, não o project
// id, e não há email/email_verified/admin — App Check não autentica
// ninguém, só atesta que o cliente parece de verdade).
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyAppCheckToken, type AppCheckKeyFetcher } from "../src/admin/appCheck.js";

const PROJECT_NUMBER = "896501484372";
const NOW = 1_760_000_000_000;
const nowSec = Math.floor(NOW / 1000);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid";
const fetcher: AppCheckKeyFetcher = async () => ({ [KID]: publicKey.export({ format: "jwk" }) });

// Preâmbulo: makeToken() espelha a função homônima em firebaseAuth.test.ts,
// com as claims do App Check em vez das de login.
function makeToken(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT", ...header })).toString("base64url");
  const p = Buffer.from(
    JSON.stringify({
      aud: [`projects/${PROJECT_NUMBER}`],
      iss: `https://firebaseappcheck.googleapis.com/${PROJECT_NUMBER}`,
      sub: "app-id-123",
      iat: nowSec - 10,
      exp: nowSec + 3600,
      ...claims,
    })
  ).toString("base64url");
  const s = sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url");
  return `${h}.${p}.${s}`;
}

describe("verifyAppCheckToken", () => {
  it("aceita um token válido", async () => {
    expect(await verifyAppCheckToken(makeToken(), PROJECT_NUMBER, fetcher, NOW)).toBe(true);
  });

  // Preâmbulo: aud vem como ARRAY no App Check (diferente do ID token de
  // login, onde aud é uma string só) — token de outro projeto não deve bater.
  it("recusa token de outro projeto (aud não contém o número certo)", async () => {
    expect(
      await verifyAppCheckToken(makeToken({ aud: ["projects/outro-numero"] }), PROJECT_NUMBER, fetcher, NOW)
    ).toBe(false);
  });

  it("recusa iss de outro projeto", async () => {
    expect(
      await verifyAppCheckToken(
        makeToken({ iss: "https://firebaseappcheck.googleapis.com/outro-numero" }),
        PROJECT_NUMBER,
        fetcher,
        NOW
      )
    ).toBe(false);
  });

  it("recusa token expirado", async () => {
    expect(await verifyAppCheckToken(makeToken({ exp: nowSec - 3600 }), PROJECT_NUMBER, fetcher, NOW)).toBe(false);
  });

  it("recusa payload adulterado (assinatura não bate mais)", async () => {
    const [h, , s] = makeToken().split(".");
    const forged = Buffer.from(JSON.stringify({ aud: [`projects/${PROJECT_NUMBER}`] })).toString("base64url");
    expect(await verifyAppCheckToken(`${h}.${forged}.${s}`, PROJECT_NUMBER, fetcher, NOW)).toBe(false);
  });

  it("recusa alg diferente de RS256 (incluindo none)", async () => {
    expect(await verifyAppCheckToken(makeToken({}, { alg: "none" }), PROJECT_NUMBER, fetcher, NOW)).toBe(false);
    expect(await verifyAppCheckToken(makeToken({}, { alg: "HS256" }), PROJECT_NUMBER, fetcher, NOW)).toBe(false);
  });

  it("recusa token malformado", async () => {
    expect(await verifyAppCheckToken("abc", PROJECT_NUMBER, fetcher, NOW)).toBe(false);
    expect(await verifyAppCheckToken("a.b.c", PROJECT_NUMBER, fetcher, NOW)).toBe(false);
  });

  // Preâmbulo: aud ausente ou no formato errado (string em vez de array,
  // por exemplo um token de ID normal batendo nesta função por engano) não
  // deve lançar, só recusar - Array.isArray() cobre isso em appCheck.ts.
  it("recusa aud que não é um array", async () => {
    expect(
      await verifyAppCheckToken(makeToken({ aud: `projects/${PROJECT_NUMBER}` }), PROJECT_NUMBER, fetcher, NOW)
    ).toBe(false);
  });
});
