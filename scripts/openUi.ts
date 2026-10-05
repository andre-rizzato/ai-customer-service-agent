// Abre a tela de configuração (public/settings.html) no navegador padrão do
// SO — conveniência pro fluxo de debug local descrito em
// docs/DEBUG_LOCAL.md (seções 5 e 6): testar o agente bypassando WhatsApp/
// Telegram via o canal "web", sem precisar digitar a URL na mão toda vez.
//
// Fica em scripts/ (fora de src/) e roda SÓ UMA VEZ, antes do servidor
// subir — não dentro de src/server.ts — porque `npm run dev` usa `tsx
// watch`, que reinicia o processo inteiro a cada arquivo salvo; se o open
// do navegador estivesse dentro do callback de app.listen(), toda vez que
// você salvasse um arquivo uma aba nova se abriria sozinha.
//
// Uso:
//   npm run dev:ui
//
// (equivalente a abrir a URL manualmente + "npm run dev" em paralelo)
import { exec } from "node:child_process";

// Mesmo default de src/config.ts (PORT) — lido direto de process.env em vez
// de importar o módulo de config inteiro, que validaria agent.config.json e
// todo o resto do .env só pra descobrir uma porta.
const port = process.env.PORT ?? "3000";
const url = `http://localhost:${port}/settings.html`;

// Comando de abrir URL no navegador padrão difere por sistema operacional —
// `start` no Windows precisa do primeiro argumento vazio ("") porque senão
// ele interpreta a URL como o título da janela do cmd.
const command =
  process.platform === "win32"
    ? `start "" "${url}"`
    : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;

console.log(`Abrindo ${url} no navegador...`);
exec(command, (err) => {
  if (err) {
    // Falha em abrir o navegador automaticamente não deveria impedir o
    // resto do fluxo (quem chamou este script normalmente encadeia "&& npm
    // run dev" na sequência) — só avisa e mostra a URL pra abrir na mão.
    console.error(`Não consegui abrir o navegador automaticamente: ${err.message}`);
    console.error(`Abra manualmente: ${url}`);
  }
});
