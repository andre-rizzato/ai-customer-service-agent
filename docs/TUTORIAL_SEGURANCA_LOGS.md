# Tutorial: verificar a segurança e saber se houve tentativa de ataque

Como responder, com certeza, a três perguntas: **alguém tentou atacar? Alguém
conseguiu? E onde está a prova?** Cobre a VM (SSH e o agente atrás do Nginx),
o site institucional e o Azure.

Foi assim que a auditoria de 06/10/2026
([`SECURITY_AUDIT_2026-10-06.md`](SECURITY_AUDIT_2026-10-06.md)) achou o "IP
diferente" (um scanner em 04/10) e confirmou que não houve invasão.

Última atualização: 06/10/2026.

---

## 1. O jeito rápido: um comando só

Do seu computador, na pasta do repositório:

```bash
# últimas 24h
ssh azureuser@20.127.12.103 'bash -s' < scripts/security-check.sh

# últimos 7 dias
ssh azureuser@20.127.12.103 'bash -s' -- 7 < scripts/security-check.sh
```

O script roda **na VM** pela conexão SSH, só lendo logs (não altera nada, não
copia arquivo nenhum pra lá). Ele responde em 5 seções, da mais grave pra menos
grave.

### Como ler cada seção

**1. LOGINS SSH ACEITOS: alguém entrou?** ← *a mais importante*

```text
      2 Oct 06  52.161.50.37    deploy do GitHub Actions
     22 Oct 06  45.190.220.133  sua chave pessoal (id_rsa)
```

- ✅ **Normal:** só "sua chave pessoal" (do seu IP) e "deploy do GitHub
  Actions" (IPs da Microsoft, 2-4 logins por deploy, no horário dos pushes).
- 🚨 **Incidente:** `⚠️ CHAVE DESCONHECIDA` ou `⚠️ LOGIN POR password`. Alguém
  entrou com uma chave que não é sua, ou por senha (que deveria estar
  desligada). Vá direto pra seção 6.
- Para conferir um deploy: `gh run list --workflow deploy.yml` mostra os
  horários. Eles devem bater com os logins "deploy".

**2. TENTATIVAS DE LOGIN SSH: tentaram entrar?**

```text
tentativas falhas: 1697
-- top IPs:  330 197.248.15.98 ...
-- usuários mais tentados:  344 admin, 252 ubuntu ...
```

- ✅ **Normal:** centenas a milhares por dia. São robôs varrendo a internet,
  testando usuários comuns (`admin`, `ubuntu`, `test`). **Eles não conseguem
  entrar**: a VM só aceita chave, nunca senha. Isto é *tentativa*, não
  *invasão*.
- 🟠 **Merece atenção:** tentativas com o usuário **`azureuser`** vindas de um
  IP que não é o seu (alguém que sabe o seu usuário), ou um salto muito grande
  de volume.

**3. SITE: VOLUME E SONDAGENS**

```text
-- padrões de ataque (quantidade):
   414  phpunit|eval-stdin|\.php
    94  \.env
    78  \.git/
```

- ✅ **Normal:** robôs procurando falhas de PHP, WordPress, `.env`, `.git/`.
  Tudo dá **404**, porque nada disso existe aqui (o agente é Node, e o Nginx só
  repassa pro app).
- O número de padrões de ataque mede **tentativa**. O que importa de verdade
  é a seção 4.

**4. ⚠️ ESTRANHOS COM SUCESSO (2xx) EM ROTA SENSÍVEL** ← *o alarme do site*

```text
nenhum ✅
```

- ✅ **Normal:** "nenhum". Telegram e Meta (WhatsApp) recebendo 200 nos
  webhooks já são filtrados, porque é o funcionamento normal.
- 🚨 **Incidente:** qualquer linha aqui. Um IP desconhecido recebeu resposta de
  **sucesso** em `/api/config`, `/settings.html`, `/api/handoff/...` ou num
  webhook. Vá pra seção 6.

**5. SAÚDE E ATUALIZAÇÃO DA VM**

- `⚠️ reboot pendente`: correções de kernel/libc baixadas, mas só valem depois
  de `sudo reboot`.
- `updates de segurança` > 0 por mais de 1-2 dias: o `unattended-upgrades` não
  está dando conta; rode `sudo apt upgrade`.
- `bloqueio da tela de config no Nginx`: tem que ser **404**. Se der 200, a
  tela de configuração voltou a ficar aberta pra internet.
- Certificado com menos de 30 dias: a renovação automática falhou
  (`sudo certbot renew --dry-run` pra ver o erro).

### Com que frequência

- **Semanal:** `-- 7` (os últimos 7 dias).
- **Depois de algo estranho** (bot fora do ar, comportamento esquisito, alerta
  do Azure): na hora, com `-- 1`.

---

## 2. Onde ficam os logs (o mapa)

| O que registra | Onde | Quanto tempo guarda |
|---|---|---|
| Logins e tentativas SSH | `journalctl -u ssh` (systemd journal) | enquanto couber no journal (hoje: desde o 1º boot, 03/10) |
| Cada requisição ao site do agente | `/var/log/nginx/access.log` (+ `.1` e `.gz` rotacionados) | 14 dias (`/etc/logrotate.d/nginx`: `daily`, `rotate 14`). Passou disso, apagou: copie antes se precisar guardar |
| Erros do Nginx (TLS, upstream fora) | `/var/log/nginx/error.log` | idem |
| Saída e erros do agente | `~/.pm2/logs/agente-atendimento-out.log` / `-error.log` | até apagar (`pm2 flush`) |
| Conversas e handoffs (auditoria do bot) | `~/agente-atendimento/data/audit-log.jsonl` | permanente |
| Quem mudou recursos no Azure (VM, NSG, Key Vault) | Azure Activity Log | 90 dias |
| Updates automáticos | `/var/log/unattended-upgrades/` | rotativo |

> **O site institucional** (`www.rizzatotech.com`, Azure Static Web Apps) **não
> tem log de acesso** no plano gratuito. Ele é só arquivo estático (sem
> servidor, banco nem login funcional), então a superfície de ataque é mínima.
> Se um dia precisar ver acessos, o caminho é ligar o Application Insights no
> Static Web App (tem custo por volume). O widget de chat do site fala com o
> agente, e **essas** requisições aparecem no log do Nginx da VM.

---

## 3. Investigando à mão (os comandos por trás do script)

Entre na VM (`ssh azureuser@20.127.12.103`) e use estes comandos quando quiser
ir além do resumo.

### 3.1 SSH

```bash
# Quem ENTROU (a pergunta mais importante) — atenção ao padrão exato:
# buscar só "Accepted" também pega "...not in PubkeyAcceptedAlgorithms",
# que é chave REJEITADA, não login (armadilha real da auditoria de 06/10).
sudo journalctl -u ssh --since "7 days ago" | grep -E "Accepted (publickey|password)"

# Qual chave é qual (compare o SHA256 com o do login acima)
ssh-keygen -lf ~/.ssh/authorized_keys

# Tentativas falhas por IP
sudo journalctl -u ssh --since "24 hours ago" | grep -Ei "invalid user|failed" \
  | grep -Eo "from [0-9.]+" | sort | uniq -c | sort -rn | head

# Tudo o que um IP específico fez no SSH
sudo journalctl -u ssh | grep "197.248.15.98"
```

### 3.2 Nginx (site do agente)

```bash
# Ler TODOS os arquivos (atual + rotacionados + compactados) de uma vez
alias nglog='sudo sh -c "cat /var/log/nginx/access.log /var/log/nginx/access.log.1 2>/dev/null; zcat /var/log/nginx/access.log.*.gz 2>/dev/null"'

# Top IPs
nglog | awk '{print $1}' | sort | uniq -c | sort -rn | head

# Tudo o que um IP fez (foi assim que se achou o scanner de 04/10)
nglog | grep "^46.151.182.7 "

# Quem acessou a tela de configuração (deve ser 404 pra todos desde 06/10 01:07 UTC)
nglog | grep -E "settings\.html|/api/config"

# Sucessos (2xx) de quem NÃO é você em rotas sensíveis
nglog | grep -v "^45.190.220.133 " | awk '$9 ~ /^2/' | grep -E "/api/|settings|handoff"

# Ver em tempo real (Ctrl+C pra sair)
sudo tail -f /var/log/nginx/access.log
```

**Anatomia de uma linha do access log:**

```text
46.151.182.7 - - [04/Oct/2026:14:21:22 +0000] "GET /api/config HTTP/1.1" 404 149 "-" "Mozilla/5.0 ..."
└─ IP ──────┘     └─ data/hora (UTC) ───────┘  └─ método + caminho ──┘    └status┘ └bytes┘    └─ navegador/robô
```

O que mais importa é o **status**: `404` = não existe/bloqueado; `200` = foi
servido; `502` = app fora do ar.

### 3.3 Descobrir quem é um IP

O `whois` não vem instalado na VM. Rode do seu computador (no Git Bash do
Windows ele também não vem; use o navegador) ou instale na VM com
`sudo apt install whois`:

```bash
whois 46.151.182.7 | grep -iE "country|org-name|netname|descr" | head
```

Ou pelo navegador: `https://www.abuseipdb.com/check/<ip>`. Mostra se o IP já
foi denunciado como scanner/atacante. Os da auditoria de 06/10 são robôs
conhecidos.

**IPs que você vai ver e são legítimos:**

| IP / faixa | Quem é |
|---|---|
| `45.190.220.133` | você (pode mudar se a sua internet trocar de IP) |
| `13.x`, `20.x`, `52.x`, `172.x`, `135.x`, `64.236.x`, `132.196.x` com a chave de deploy | runners do GitHub Actions (rodam na Azure) |
| `91.108.x`, `149.154.x` | Telegram entregando mensagens no webhook |
| `173.252.x`, `31.13.x`, `69.171.x`, `157.240.x` | Meta (WhatsApp) |

### 3.4 Azure: alguém mexeu na infraestrutura?

Do seu computador (com `az login`):

```bash
az monitor activity-log list -g rg-agente-atendimento --offset 7d \
  --query "[?contains(operationName.value,'write') || contains(operationName.value,'delete')].{t:eventTimestamp, op:operationName.value, quem:caller}" -o table
```

Todas as linhas devem ser `andre.rizzato@outlook.com` (ou a identidade de um
serviço seu). Uma alteração de regra de firewall (`networkSecurityGroups/write`)
ou de Key Vault feita por outra pessoa é **incidente**.

Regras de firewall atuais (devem ser só 22, 80, 443):

```bash
az network nsg rule list -g rg-agente-atendimento --nsg-name vm-agenteNSG \
  --query "[].{nome:name, porta:destinationPortRange, origem:sourceAddressPrefix}" -o table
```

---

## 4. Tentativa × invasão: como diferenciar

| Você vê | É | Faça |
|---|---|---|
| Milhares de SSH falhos de IPs aleatórios | tentativa (ruído normal) | nada; acompanhar o volume |
| 404 em `.env`, `.php`, `wp-login`, `.git/` | tentativa (scanner) | nada |
| Login SSH aceito com chave conhecida, no horário de deploy/uso seu | normal | nada |
| SSH falho com usuário `azureuser` de IP estranho | tentativa **direcionada** | anotar o IP; considerar restringir a porta 22 |
| **Login SSH aceito com chave desconhecida ou por senha** | **INVASÃO** | seção 6 |
| **2xx de IP estranho em `/api/config`, `/settings.html`, `/api/handoff`** | **acesso indevido** | seção 6 |
| Arquivo `agent.config.json` mudou sem você ter salvo | **possível acesso indevido** | seção 6 |
| Alteração no Azure feita por outra conta | **INVASÃO da conta Azure** | seção 6 + trocar senha/MFA da conta |

Para conferir se a config mudou sem você saber: o horário do arquivo e a última
versão anterior estão na VM.

```bash
stat -c "%y" ~/agente-atendimento/config/agent.config.json
diff <(python3 -m json.tool ~/agente-atendimento/config/agent.config.json.bak) \
     <(python3 -m json.tool ~/agente-atendimento/config/agent.config.json)
```

Cruze o horário com o access log (`nglog | grep "POST /api/config"`). Foi assim
que se confirmou que o save de 06/10 00:23 UTC era seu.

---

## 5. Sinais nos logs do agente (PM2)

```bash
pm2 logs agente-atendimento --lines 100
```

- Muitos `401` em `/webhook/telegram`: alguém tentando forjar mensagens do
  Telegram sem o segredo do webhook (bloqueado).
- `Handoff webhook notify failed` / `Telegram ... failed`: problema de entrega,
  não ataque.
- Reinícios inesperados (`pm2 list`, coluna `↺`) sem deploy: verificar memória
  (`free -m`) e o `-error.log`.

---

## 6. Se encontrar um incidente

1. **Não apague logs.** Eles são a prova. Copie antes de qualquer coisa:
   ```bash
   mkdir -p ~/incidente-$(date +%F) && sudo cp -a /var/log/nginx /var/log/auth.log* ~/incidente-$(date +%F)/
   sudo journalctl -u ssh > ~/incidente-$(date +%F)/ssh.log
   ```
2. **Cortar o acesso:**
   - Chave desconhecida: remova a linha de `~/.ssh/authorized_keys`.
   - Chave de deploy suspeita: remova a linha dela, apague o secret
     `DEPLOY_SSH_KEY` no GitHub e gere uma nova (lembrando do `icacls` no
     Windows, ver `CLAUDE.md`).
   - Acesso à tela de configuração: confira o bloqueio do Nginx
     (`TUTORIAL_CONFIGURACAO.md`) e restaure a config do `.bak` se ela foi
     alterada.
3. **Trocar segredos** que a máquina podia ler: tokens do Telegram/WhatsApp,
   chaves de API (Anthropic, Voyage), tudo no Key Vault.
4. **Conta Azure:** se houver alteração de terceiros no Activity Log, troque a
   senha e confirme o MFA da conta antes de qualquer outra coisa.
5. Registre o que aconteceu em `docs/STATUS.md` (como o incidente de 03/10).

---

## 7. Próximo passo possível: alerta automático

Hoje a verificação é **manual** (você roda o script). Para saber de uma
tentativa **sem precisar olhar**, o caminho mais barato é um `cron` na VM que
roda `scripts/security-check.sh` uma vez por dia e manda **só as seções 1 e 4**
(as que indicam invasão) pro seu Telegram, pelo bot que já existe. Custo: zero
de infraestrutura e nenhum processo residente (o cron roda e sai). Ainda não
implementado: ver as recomendações da auditoria.
