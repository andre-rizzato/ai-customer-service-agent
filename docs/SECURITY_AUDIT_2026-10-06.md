# Auditoria de segurança da VM: 06/10/2026

Varredura **somente leitura** da VM de produção do agente
(`vm-agente`, resource group `rg-agente-atendimento`, IP `20.127.12.103`), dos
logs de acesso e do site. Nenhuma configuração foi alterada durante a
auditoria. A única mudança de segurança do dia, o bloqueio da tela de
configuração no Nginx, foi feita **antes** e está em
[`TUTORIAL_CONFIGURACAO.md`](TUTORIAL_CONFIGURACAO.md).

Complementa a revisão de código de 04/10 ([`SECURITY_REVIEW.md`](SECURITY_REVIEW.md)):
aquela olhou o código, esta olha a máquina e o tráfego real.

Como repetir: [`TUTORIAL_SEGURANCA_LOGS.md`](TUTORIAL_SEGURANCA_LOGS.md) e
`scripts/security-check.sh`.

---

## 1. Resumo executivo

**Não houve invasão.** Todos os logins aceitos na VM, desde que ela existe
(03/10), são da sua chave pessoal ou da chave de deploy do GitHub Actions, nos
horários exatos dos deploys. Nenhum IP desconhecido recebeu resposta de sucesso
em rota sensível. O log de atividades do Azure só registra alterações feitas
pela sua conta.

**Há tentativas constantes**, o normal pra qualquer IP público:

- **SSH:** ~5.600 tentativas de login em 3 dias (robôs testando `admin`,
  `ubuntu`, `user`...). Todas falham, porque a VM só aceita chave, nunca senha.
- **Site:** robôs sondando falhas conhecidas de PHP, `.env`, `.git/` e
  WordPress. Todas recebem 404 (não existe nada disso aqui).

**Riscos a corrigir**, por prioridade:

| # | Severidade | Achado | Custo pra corrigir |
|---|---|---|---|
| 1 | 🔴 Alta | Chave de deploy do GitHub tem shell completo + `sudo` sem senha: vazar o secret do GitHub = root na VM | zero (config) |
| 2 | 🟠 Média | Reboot pendente: kernel e `libc6` atualizados mas **não ativos** até reiniciar | ~1-2 min fora do ar |
| 3 | 🟠 Média | 5 vulnerabilidades (1 crítica) em dependência **opcional e não usada** (`@xenova/transformers`) instalada na VM | zero (`npm ci --omit=optional`) |
| 4 | 🟡 Baixa | Configuração do SSH pode ser endurecida (`PermitRootLogin`, `X11Forwarding`, `MaxAuthTries`) | zero |
| 5 | 🟡 Baixa | Versões expostas nos headers (`nginx/1.18.0 (Ubuntu)`, `X-Powered-By: Express`) | zero |
| 6 | 🟡 Baixa | Faltam headers de segurança no agente (HSTS, `nosniff`) | zero |
| 7 | 🟡 Baixa | Node escuta em todas as interfaces (`*:3000`); só o firewall do Azure impede acesso direto | zero |
| 8 | ⚪ Info | Página padrão do Nginx em `http://20.127.12.103`; firewall local (`ufw`) e `fail2ban` desligados | ver texto |
| 9 | ⚪ Info | Site: 4 vulnerabilidades altas na cadeia do `firebase` (via `@grpc/grpc-js`) | atualizar quando houver correção |

---

## 2. O que foi verificado

| Área | Como |
|---|---|
| Logins SSH (aceitos e falhos) | `journalctl -u ssh` desde o 1º boot (03/10 03:07 UTC), impressões digitais das chaves em `authorized_keys` |
| Tráfego do site | access log do Nginx: atual, rotacionado e `.gz` |
| Portas e firewall | `ss -ltnup`, regras do NSG do Azure (`az network nsg list`), `ufw` |
| SSH | configuração efetiva (`sshd -T`) |
| Sistema | versão, reboot pendente, updates, `unattended-upgrades` |
| Contas | usuários com shell, grupo `sudo`, regras `NOPASSWD` |
| Arquivos | permissões de `.env`, `authorized_keys`, arquivos graváveis por todos |
| Processos | usuário de cada processo (Node, PM2, uvicorn) |
| TLS | protocolos aceitos (externo, `openssl s_client`), validade e renovação dos certificados |
| HTTP | headers de resposta do agente e do site; CORS com origem não autorizada |
| Dependências | `npm audit --omit=dev` (agente e site); `pip list --outdated` (agent-service) |
| Azure | log de atividades do resource group (7 dias): quem alterou o quê |

---

## 3. Atividade de ataque observada

### 3.1 SSH: força bruta (sem sucesso)

- **~5.600 tentativas** de 03/10 a 06/10 (~1.700 só nas últimas 24h).
- Top IPs: `197.248.15.98` (330), `144.225.6.182` (181), `2.57.122.74` (130),
  `121.40.119.125` (84), `80.94.92.55` (81).
- Usuários tentados: `admin` (774), `ubuntu` (418), `user` (398), `debian`
  (248), `test` (172), `deploy` (138), `postgres` (112).
- **Por que não funciona:** `PasswordAuthentication no` e
  `KbdInteractiveAuthentication no`. Sem a chave privada, não há o que
  adivinhar.

### 3.2 Logins aceitos: todos legítimos

| Chave (impressão digital) | Dono | De onde |
|---|---|---|
| `SHA256:hVAlRDrY…fZE` (RSA) | sua chave pessoal | `45.190.220.133` (seu IP) |
| `SHA256:IbB+6Jl7…zanOk` (ED25519) | `github-actions-deploy@vm-agente` | IPs da Microsoft (runners do GitHub), 2-4 logins por deploy, **horários idênticos aos 14 deploys** do `gh run list` |

> Armadilha encontrada: a busca ingênua por "Accepted" também pega
> `key type ssh-rsa not in PubkeyAcceptedAlgorithms`, que é uma chave
> **rejeitada**, não um login. O script e o tutorial buscam
> `Accepted publickey|password`.

### 3.3 Site: sondagem automática (sem sucesso)

Fora o seu IP, ~1.800 requisições em 3 dias, das quais ~1.060 deram 404.
Padrões típicos de scanner:

| Padrão | Ocorrências | O que procuram |
|---|---|---|
| `phpunit/eval-stdin.php`, `.php` | 414 | RCE antigo do PHPUnit |
| `.env` | 94 | arquivo de segredos esquecido na raiz |
| `.git/` | 78 | código-fonte exposto |
| `invokefunction`, `allow_url_include` | 42 | RCE do ThinkPHP / PHP-CGI |
| `/cgi-bin` | 36 | Shellshock e afins |
| `../`, `%2e%2e` | 21 | path traversal |
| `wp-login`, `xmlrpc` | 16 | WordPress |

Nada disso existe aqui (é Node, não PHP; o Nginx só repassa pro app), por
isso tudo dá 404.

**Requisições com sucesso de terceiros em rotas sensíveis:** só
`POST /webhook/telegram` de `91.108.5.101` (faixa do Telegram) e a verificação
do webhook do WhatsApp de `173.252.70.61` (Meta, user-agent
`facebookplatform/1.0`). Ambas legítimas.

**Tela de configuração:** antes do bloqueio (01:07 UTC de 06/10), os únicos
acessos com sucesso foram do seu IP. Um scanner em **04/10 14:21 UTC**
(`46.151.182.7`) procurou `/api/config`, `/.env`, `/CLAUDE.md` e
`/AGENTS.md`, e recebeu 404, porque a tela ainda não existia no servidor.
Prova de que robôs procuram exatamente esse caminho.

### 3.4 Azure (plano de controle)

Log de atividades do RG (7 dias): todas as alterações (criação da VM, role
assignments, Key Vault, restarts e `runCommand` do incidente de 03/10) foram
feitas por `andre.rizzato@outlook.com`. Nenhuma alteração de terceiros.

---

## 4. Achados em detalhe

### 🔴 1. Chave de deploy = acesso root

**Evidência:** a chave `github-actions-deploy@vm-agente` em
`~/.ssh/authorized_keys` tem `no-port-forwarding,no-X11-forwarding,no-agent-forwarding`,
mas **nenhum `command=`**: ela abre um shell completo. E `azureuser` tem
`ALL=(ALL) NOPASSWD:ALL` (`/etc/sudoers.d/90-cloud-init-users`).

**Risco:** quem obtiver o secret `DEPLOY_SSH_KEY` do GitHub (vazamento de
token, Action de terceiros comprometida, colaborador indevido) vira root na
VM, com acesso ao Key Vault via Managed Identity.

**Correção sugerida** (custo zero, sem impacto de RAM): restringir a chave a
um script de deploy com `command="/home/azureuser/bin/deploy-gate.sh",restrict`
que só aceita o `rsync` e o `pm2 restart` que o workflow usa, ou criar um
usuário `deploy` sem sudo, dono só da pasta do app. Exige ajustar
`deploy.yml` junto, então precisa ser testado com cuidado.

### 🟠 2. Reboot pendente

**Evidência:** `/var/run/reboot-required` cita `linux-image-6.8.0-1068-azure`,
`linux-base`, `libc6`. O kernel em uso é o `6.8.0-1064`.

**Risco:** as correções já baixadas pelo `unattended-upgrades` não valem até
reiniciar. O kernel e a libc são justamente as peças mais sensíveis.

**Correção:** `sudo reboot` num horário calmo. Conferido: o PM2 sobe sozinho
no boot (`pm2-azureuser` está `enabled` e `active`, e `~/.pm2/dump.pm2` foi
salvo no deploy de 06/10 01:31). Downtime de ~1-2 min. O incidente de
03/10 mostrou que a VM já reiniciou e voltou com os processos.

### 🟠 3. Dependências vulneráveis não usadas

**Evidência:** `npm audit --omit=dev` no agente: 5 vulnerabilidades (1
crítica: `protobufjs`, execução de código; 4 altas: `sharp`/libvips,
`onnxruntime-web`, `onnx-proto`). Todas vêm de `@xenova/transformers`
(`optionalDependencies`, embeddings locais), **instalado na VM** mas não usado:
`EMBEDDING_PROVIDER=voyage` e o pacote só é carregado por `import()` dinâmico
quando `local` é escolhido.

**Risco real:** baixo, porque o código vulnerável nunca é carregado. Mas é
superfície desnecessária, e o pacote (com o modelo ONNX) pesa no `npm ci` da
VM, a mesma operação que causou o incidente de memória de 03/10.

**Correção:** `npm ci --omit=optional` no `deploy.yml`. Elimina as 5
vulnerabilidades da VM **e** reduz o pico de memória e disco do deploy. Quem
quiser embeddings locais em dev continua com `npm install` normal.

### 🟡 4. SSH endurecível

`sshd -T`: `permitrootlogin without-password` (o root já está bloqueado pela
chave padrão do Azure, que só imprime "use azureuser", mas o certo é `no`),
`x11forwarding yes` (desnecessário numa VM sem interface gráfica),
`maxauthtries 6`. Sugestão: `PermitRootLogin no`, `X11Forwarding no`,
`MaxAuthTries 3`. **Não** desligar `AllowTcpForwarding`: o túnel da tela de
configuração depende dele.

### 🟡 5. Versões expostas

`Server: nginx/1.18.0 (Ubuntu)` e `X-Powered-By: Express`. Dão ao scanner o
mapa do que testar. Correção: `server_tokens off;` no `nginx.conf` (hoje
comentado) e `app.disable("x-powered-by")` no `server.ts`.

### 🟡 6. Headers de segurança ausentes no agente

O site (Azure Static Web Apps) já manda HSTS, `X-Content-Type-Options` e
`Referrer-Policy`. O agente não manda nenhum. Sugestão no Nginx:
`Strict-Transport-Security` e `X-Content-Type-Options: nosniff`.
**Cuidado com `X-Frame-Options: DENY`:** o Mini App (`handoff-app.html`) roda
dentro de um iframe no Telegram Web e quebraria. Se for adicionar, excluir
essa página ou usar `frame-ancestors` liberando o Telegram.

### 🟡 7. Node em todas as interfaces

`ss` mostra `*:3000`. O NSG do Azure só libera 22/80/443 (confirmado: a porta
3000 não responde de fora), então hoje não é explorável. Mas uma regra de NSG
aberta por engano exporia o app sem Nginx. Defesa em profundidade: escutar em
`127.0.0.1` (o `agent-service` já faz isso desde a revisão de 04/10). O túnel
SSH continua funcionando.

### ⚪ 8. Outros pontos (informativos)

- `http://20.127.12.103` mostra a página padrão "Welcome to nginx!". Inofensivo,
  mas confirma pra robôs que há um Nginx. Pode virar `return 444;`.
- `ufw` inativo e `fail2ban` ausente. O NSG já faz o papel de firewall. O
  `fail2ban` só reduziria ruído de log (as tentativas já falham), e custa
  ~30-50 MB de RAM num processo Python residente, que pesa na B1s de 892 MB
  (ver `CLAUDE.md`). Recomendação: **não instalar agora**; reavaliar com VM
  maior.
- O `hub.verify_token` do WhatsApp aparece no access log (vem na querystring da
  Meta). O log só é legível por root/adm, e o token só protege o handshake
  inicial. Aceitável.
- `whatsapp.html` (simulador) continua público. Ele conversa com o mesmo
  endpoint do widget, que é público por natureza e tem rate limit.
- `agent-service`: alguns pacotes Python desatualizados (`openai` 3.3 → 3.24,
  `aiohttp`, `langgraph`...); `pip-audit` não está instalado, então não houve
  checagem de CVE do lado Python. Sugestão: rodar `pip-audit` localmente.

### ⚪ 9. Site

`npm audit --omit=dev` no `rizzatotech-site`: 4 altas na cadeia
`firebase → @firebase/firestore → @grpc/grpc-js`. O site é exportação
estática e não usa Firestore. Risco prático baixo. Atualizar o `firebase`
quando sair versão corrigida.

---

## 5. O que está bem ✅

- Login SSH **só por chave**; senha e teclado interativo desligados.
- Root efetivamente bloqueado.
- TLS **só 1.2 e 1.3** (1.0 e 1.1 recusados); certificados válidos até
  02-03/01/2027, com renovação automática (`certbot.timer` ativo).
- NSG libera só 22, 80, 443. A porta 3000 está fechada de fora.
- `agent-service` escuta só em `127.0.0.1:8100`.
- Nenhum processo da aplicação roda como root (Node, PM2, uvicorn = `azureuser`).
- `.env` com permissão `600`; nenhum arquivo do app gravável por todos.
- `unattended-upgrades` ativo; **0 updates de segurança pendentes**.
- CORS do widget correto: origem não autorizada não recebe header.
- Tela de configuração bloqueada de fora (404), inclusive com variações de
  maiúsculas e encoding.
- Segredos no Key Vault, não no disco.

---

## 6. Próximos passos sugeridos (ordem)

1. **Reboot** (achado 2). O PM2 já está configurado pra subir no boot.
2. **`npm ci --omit=optional`** no deploy (achado 3).
3. **Restringir a chave de deploy** (achado 1). Exige mudar o `deploy.yml`, então
   fazer com teste.
4. Endurecer SSH e esconder versões, além de headers e bind em `127.0.0.1`
   (achados 4-7). Todos de custo zero, num único deploy.
5. Rodar `scripts/security-check.sh` semanalmente (ver tutorial). Considerar um
   alerta automático diário no Telegram do atendente (o bot já existe).

Nenhum desses passos foi executado. Todos aguardam sua decisão.
