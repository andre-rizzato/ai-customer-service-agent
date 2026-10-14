// Ferramenta de linha de comando pra promover (ou revogar) um admin da tela
// de configuração — substitui editar ADMIN_EMAILS no .env e reiniciar o PM2
// (13/10/2026, ver src/admin/firebaseAuth.ts e docs/ADMIN_AUTH.md). Em vez
// disso, seta um CUSTOM CLAIM (`admin: true`) no usuário do Firebase — o
// Firebase passa a incluir esse claim em todo ID token daquele usuário a
// partir do próximo login/renovação, e o servidor já sabe ler isso (ver
// isAdmin() em src/admin/firebaseAuth.ts).
//
// Uso, da sua máquina (NUNCA precisa rodar na VM — isso não é parte do
// processo do bot, é uma ferramenta de operador, roda uma vez por admin
// promovido):
//
//   FIREBASE_SERVICE_ACCOUNT_FILE=./minha-service-account.json \
//     npx tsx scripts/setAdminClaim.ts admin@exemplo.com
//
//   # pra revogar:
//   FIREBASE_SERVICE_ACCOUNT_FILE=./minha-service-account.json \
//     npx tsx scripts/setAdminClaim.ts admin@exemplo.com --revoke
//
// A Service Account (JSON) se gera em: Firebase Console → Configurações do
// projeto → Contas de serviço → Gerar nova chave privada. É uma credencial
// de verdade (acesso total ao Auth do projeto) — NUNCA comitar esse arquivo,
// guardar só na sua máquina, fora do repositório.
//
// Por que não usar o pacote firebase-admin: ele traz gRPC e dezenas de MB de
// dependências — inofensivo rodando uma vez na sua máquina, mas se entrasse
// no package.json deste repo, `npm ci` o instalaria TAMBÉM na VM de 892MB a
// cada deploy (o workflow não usa --omit=dev), mesmo esta ferramenta nunca
// rodando lá. Em vez disso: as mesmas três chamadas REST que o SDK faz por
// baixo dos panos, assinadas "na mão" com node:crypto — mesmo raciocínio (e
// mesmo tamanho, ~uma função por chamada) que já guia verifyFirebaseIdToken
// em src/admin/firebaseAuth.ts.
//
// NÃO exercitado contra uma Service Account de verdade nesta sessão (nenhuma
// disponível) — o formato das três chamadas segue a documentação oficial da
// Identity Toolkit API e do fluxo OAuth2 de Service Account do Google, mas
// confirme contra um projeto real antes de depender disto em produção.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

// Escopo da Identity Toolkit API — é só com ESTE escopo (não o genérico
// "cloud-platform") que o access_token tem permissão pra ler/escrever
// usuários do Firebase Authentication, nem mais nem menos.
const IDENTITY_TOOLKIT_SCOPE = "https://www.googleapis.com/auth/identitytoolkit";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// Formato do arquivo baixado no Firebase Console — só os três campos que
// esta ferramenta de fato usa (o arquivo real tem mais, tipo client_id,
// token_uri etc., todos ignorados aqui).
interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

// Preâmbulo: base64url() codifica um objeto JSON no formato que um JWT
// espera em cada segmento (header/payload) — mesma função, em espírito, que
// decodeSegment() em firebaseAuth.ts faz ao contrário.
function base64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

// Preâmbulo: getAccessToken() implementa o fluxo OAuth2 "JWT Bearer" de
// Service Account (RFC 7523): monta um JWT assinado com a chave privada da
// Service Account, dizendo "eu sou esta conta de serviço, me dê um token
// com este escopo", e troca esse JWT por um access_token de verdade no
// endpoint do Google. É o mesmo mecanismo que `google-auth-library`/
// `firebase-admin` fazem por baixo — aqui replicado sem a dependência.
async function getAccessToken(serviceAccount: ServiceAccount): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: TOKEN_ENDPOINT,
    scope: IDENTITY_TOOLKIT_SCOPE,
    iat: nowSec,
    // 1h é o máximo que o Google aceita pra este tipo de asserção — não há
    // motivo pra pedir menos, o token em si expira em 1h de qualquer jeito.
    exp: nowSec + 3600,
  };

  const unsigned = `${base64url(header)}.${base64url(payload)}`;
  // createPrivateKey espera a chave no formato PEM que o arquivo da Service
  // Account já traz pronto em private_key (com os \n literais escapados no
  // JSON — JSON.parse já desfaz isso, não precisa de nada manual aqui).
  const privateKey = createPrivateKey(serviceAccount.private_key);
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
  const assertion = `${unsigned}.${signature}`;

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Falha ao trocar o JWT por um access_token (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

// Preâmbulo: lookupUid() resolve um e-mail pro uid do Firebase — o endpoint
// de escrita (accounts:update, abaixo) exige o uid, não aceita e-mail
// diretamente.
async function lookupUid(accessToken: string, projectId: string, email: string): Promise<string> {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:lookup`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: [email] }),
  });
  if (!res.ok) {
    throw new Error(`Falha ao buscar o usuário (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { users?: { localId: string }[] };
  const uid = body.users?.[0]?.localId;
  if (!uid) {
    throw new Error(`Nenhum usuário do Firebase encontrado com o e-mail "${email}" — a pessoa precisa ter feito login pelo menos uma vez antes.`);
  }
  return uid;
}

// Preâmbulo: setAdminClaim() grava o custom claim de verdade.
// `customAttributes` é uma particularidade da Identity Toolkit API: o campo
// espera uma STRING contendo JSON (não um objeto aninhado) — limite de 1000
// bytes, bem acima do que `{"admin":true}` jamais vai pesar.
async function setAdminClaim(accessToken: string, projectId: string, uid: string, value: boolean): Promise<void> {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:update`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ localId: uid, customAttributes: JSON.stringify({ admin: value }) }),
  });
  if (!res.ok) {
    throw new Error(`Falha ao gravar o custom claim (${res.status}): ${await res.text()}`);
  }
}

async function main() {
  const email = process.argv[2];
  const revoke = process.argv.includes("--revoke");

  if (!email) {
    console.error("Uso: FIREBASE_SERVICE_ACCOUNT_FILE=<arquivo.json> npx tsx scripts/setAdminClaim.ts <email> [--revoke]");
    process.exit(1);
  }

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
  if (!serviceAccountPath) {
    console.error("Defina FIREBASE_SERVICE_ACCOUNT_FILE apontando pro JSON da Service Account (Firebase Console → Configurações do projeto → Contas de serviço).");
    process.exit(1);
  }

  const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf-8")) as ServiceAccount;

  console.log(`Autenticando como ${serviceAccount.client_email}...`);
  const accessToken = await getAccessToken(serviceAccount);

  console.log(`Buscando o uid de ${email}...`);
  const uid = await lookupUid(accessToken, serviceAccount.project_id, email);

  const value = !revoke;
  console.log(`Gravando o claim admin=${value} no uid ${uid}...`);
  await setAdminClaim(accessToken, serviceAccount.project_id, uid, value);

  console.log(
    `✅ ${email} agora ${value ? "TEM" : "NÃO TEM MAIS"} acesso de administrador. ` +
      `O claim só aparece num token NOVO — a pessoa precisa deslogar e logar de novo ` +
      `(ou esperar a renovação automática do token, até 1h) pra o acesso valer de fato.`
  );
}

main().catch((err) => {
  console.error("Erro:", err instanceof Error ? err.message : err);
  process.exit(1);
});
