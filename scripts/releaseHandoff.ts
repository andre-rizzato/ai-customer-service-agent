// Ferramenta de linha de comando pro atendente humano devolver uma
// conversa pro bot depois de um handoff — o mecanismo "comando explícito"
// mencionado em docs/SECURITY_REVIEW.md item #5, enquanto não existe uma
// interface de verdade (painel ou relay via Slack, opção B discutida e
// adiada na mesma revisão). Uso, direto na VM:
//
//   npx tsx scripts/releaseHandoff.ts <conversationId>
//
// conversationId é o mesmo valor usado em todo o pipeline — pro WhatsApp,
// é o número de telefone (wa_id) tal como aparece no payload da Meta; pro
// Telegram, é o chat id.
import { HandoffStateStore } from "../src/orchestrator/handoffState.js";
import { agentConfig } from "../src/config.js";

// process.argv[0] é o executável node, [1] é este script — o primeiro
// argumento de verdade do usuário é o índice 2.
const conversationId = process.argv[2];

if (!conversationId) {
  console.error("Uso: npx tsx scripts/releaseHandoff.ts <conversationId>");
  // Código de saída != 0 sinaliza falha pra quem chamou este script (ex.:
  // um operador rodando via SSH vê o erro no próprio exit status).
  process.exit(1);
}

// Mesmo timeout configurado em agent.config.json — irrelevante pra
// release() em si (que sempre limpa o estado incondicionalmente), mas
// necessário porque o construtor de HandoffStateStore exige esse valor.
const handoffState = new HandoffStateStore(agentConfig.handoffTimeoutHours);
handoffState.release(conversationId);

console.log(`Conversa "${conversationId}" liberada — o bot volta a responder normalmente na próxima mensagem.`);
