// Encontra e encerra o processo escutando na porta do servidor local
// (PORT, default 3000) — "irmão" do scripts/openUi.ts (dev:ui). No Windows,
// `tsx watch` (usado por "npm run dev"/"dev:ui") às vezes deixa um processo
// `node` residente mesmo depois de Ctrl+C no terminal — problema real,
// batido várias vezes ao longo deste projeto (ver "Processo não morre
// depois de Ctrl+C" em docs/DEBUG_LOCAL.md, seção 9). Este script
// automatiza o netstat+taskkill manual que o guia já documentava.
//
// Uso:
//   npm run stop
import { execSync } from "node:child_process";

const port = process.env.PORT ?? "3000";

// Preâmbulo: stopWindows() junta PIDs de duas fontes antes de matar
// qualquer coisa:
//
// 1. `netstat -ano` — acha o processo de fato escutando na porta
//    configurada (o server.ts rodando).
// 2. `wmic process` filtrado por linha de comando — acha o processo "pai"
//    do `tsx watch`, que sobrevive à morte do processo de cima. `tsx
//    watch` não roda o server.ts diretamente: ele sobe um processo FILHO
//    pra isso e reinicia só esse filho a cada arquivo salvo. `taskkill
//    /PID <pid-do-filho> /T` mata a árvore do filho pra baixo, mas o PAI
//    (o processo watcher em si) fica órfão, vivo, sem nada escutando porta
//    nenhuma — achado na prática nesta sessão: sobraram dois assim depois
//    de um "npm run stop" que mirava só a porta.
//
// taskkill /F /T em cada PID encontrado, como antes.
function stopWindows(): void {
  const pids = new Set<string>();

  try {
    const netstatOut = execSync("netstat -ano", { encoding: "utf-8" });
    for (const line of netstatOut.split("\n")) {
      if (!line.includes(`:${port} `) || !line.includes("LISTENING")) continue;
      const columns = line.trim().split(/\s+/);
      const pid = columns[columns.length - 1];
      if (pid && /^\d+$/.test(pid)) pids.add(pid);
    }
  } catch (err) {
    console.error(`Não consegui rodar netstat: ${(err as Error).message}`);
  }

  try {
    // Filtra pelo texto da linha de comando NO LADO DO JS (regex abaixo)
    // em vez de dentro da cláusula WHERE do wmic — evita todo o problema
    // de escapar aspas de um jeito que sobreviva ao shell do Windows
    // dentro de execSync, pelo preço de listar todo processo node.exe
    // (lista curta, custo desprezível).
    const wmicOut = execSync('wmic process where "name=\'node.exe\'" get ProcessId,CommandLine', {
      encoding: "utf-8",
    });
    for (const line of wmicOut.split("\n")) {
      if (!/tsx(\.cmd)?.*watch.*server\.ts/i.test(line)) continue;
      const match = line.trim().match(/(\d+)\s*$/);
      if (match) pids.add(match[1]);
    }
  } catch {
    // wmic pode não existir em builds futuras do Windows (já está
    // deprecated) — degrada pra só o resultado do netstat, não pra um erro.
  }

  if (pids.size === 0) {
    console.log(`Nada rodando na porta ${port} (nem processo "tsx watch" órfão encontrado) — nada pra parar.`);
    return;
  }

  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /F /T`, { encoding: "utf-8" });
      console.log(`Processo ${pid} encerrado.`);
    } catch (err) {
      console.error(`Falha ao encerrar o processo ${pid}: ${(err as Error).message}`);
    }
  }
}

// macOS/Linux: `lsof` já devolve só o PID com -t, bem mais direto que
// parsear netstat — um kill -9 por PID encontrado.
function stopUnix(): void {
  let pids: string;
  try {
    pids = execSync(`lsof -ti:${port}`, { encoding: "utf-8" }).trim();
  } catch {
    console.log(`Nada rodando na porta ${port} — nada pra parar.`);
    return;
  }
  if (!pids) {
    console.log(`Nada rodando na porta ${port} — nada pra parar.`);
    return;
  }
  for (const pid of pids.split("\n").filter(Boolean)) {
    execSync(`kill -9 ${pid}`);
    console.log(`Processo ${pid} (porta ${port}) encerrado.`);
  }
}

if (process.platform === "win32") {
  stopWindows();
} else {
  stopUnix();
}
