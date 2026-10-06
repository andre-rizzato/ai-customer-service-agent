#!/usr/bin/env bash
# Relatório de segurança da VM do agente — SÓ LEITURA, não altera nada.
#
# Criado em 06/10/2026 junto com docs/SECURITY_AUDIT_2026-10-06.md e
# docs/TUTORIAL_SEGURANCA_LOGS.md: em vez de decorar dezenas de comandos de
# log (journalctl, zcat do Nginx, awk...), um comando só responde as
# perguntas que importam, na ordem de gravidade:
#   1. Alguém ENTROU? (logins SSH aceitos, com qual chave)
#   2. Alguém TENTOU entrar? (SSH: falhas, IPs, usuários tentados)
#   3. Alguém SONDOU ou ATACOU o site? (Nginx: scanners, padrões de ataque)
#   4. Algum estranho recebeu 200 numa rota sensível? (o sinal de alerta real)
#   5. A VM está em dia? (reboot pendente, updates, certificado, processos)
#
# Uso, do seu computador (roda na VM pelo SSH, nada é copiado pra lá):
#   ssh azureuser@20.127.12.103 'bash -s' < scripts/security-check.sh        # últimas 24h
#   ssh azureuser@20.127.12.103 'bash -s' -- 7 < scripts/security-check.sh   # últimos 7 dias
#
# Precisa de sudo sem senha (azureuser tem) só pra LER logs de root.

# Sem `set -e` de propósito: um comando sem resultado (grep que não acha nada
# devolve código 1) não pode interromper o relatório no meio.
set -u

# Janela de análise em dias (1º argumento; padrão 1 = últimas 24h).
DAYS="${1:-1}"

# Seu IP de casa/escritório, pra separar "eu" de "estranhos" na leitura.
# Deixe vazio se mudar com frequência — aí todos os IPs aparecem.
MY_IP="45.190.220.133"

# Impressões digitais das chaves autorizadas, pra traduzir "quem entrou" em
# nome legível. Atualize se trocar/adicionar chaves (ver com:
# ssh-keygen -lf ~/.ssh/authorized_keys).
declare -A KNOWN_KEYS=(
  ["SHA256:hVAlRDrY4ASZS2Vl9JC3dZe0MPmrignEiycbahn1fZE"]="sua chave pessoal (id_rsa)"
  ["SHA256:IbB+6Jl7bFFeYB14/4oXNrWxhlB4HSxjN0DfqQzanOk"]="deploy do GitHub Actions"
)

# Faixas de IP de quem DEVE receber 200 em rotas de webhook: Telegram
# (91.108.4.0/22, 149.154.160.0/20) e Meta/WhatsApp (173.252.*, 31.13.*,
# 66.220.*, 69.63.*, 69.171.*, 157.240.*). Prefixos simples, não CIDR exato —
# suficiente pra separar o tráfego legítimo do resto numa leitura humana.
LEGIT_PREFIX_REGEX='^(91\.108\.|149\.154\.|173\.252\.|31\.13\.|66\.220\.|69\.63\.|69\.171\.|157\.240\.)'

sec() { printf '\n\033[1m===== %s\033[0m\n' "$1"; }

# Preâmbulo: nginx_lines() imprime as linhas do access log do Nginx dos
# últimos DAYS dias — lê o log atual, o rotacionado (.1) e os compactados
# (.gz), e filtra pela data no formato do Nginx (06/Oct/2026). LC_ALL=C pra
# o nome do mês sair em inglês, igual ao que o Nginx grava.
nginx_lines() {
  local dates=() i
  for ((i = 0; i < DAYS; i++)); do
    dates+=("$(LC_ALL=C date -u -d "-$i day" +%d/%b/%Y)")
  done
  local pattern
  pattern=$(printf '%s|' "${dates[@]}")
  pattern="${pattern%|}"
  sudo -n sh -c 'cat /var/log/nginx/access.log /var/log/nginx/access.log.1 2>/dev/null; zcat /var/log/nginx/access.log.*.gz 2>/dev/null' \
    | grep -E "\[($pattern):"
}

# Linhas do sshd nos últimos DAYS dias.
ssh_lines() {
  sudo -n journalctl -u ssh --no-pager --since "$DAYS days ago" 2>/dev/null
}

echo "Relatório de segurança — $(hostname) — janela: últimos $DAYS dia(s) — gerado $(date -u '+%F %T') UTC"

# ---------------------------------------------------------------------------
sec "1. LOGINS SSH ACEITOS (alguém entrou?)"
# O que importa: TODA linha aqui deve ser uma chave conhecida. Uma chave
# desconhecida, ou login por senha ("Accepted password"), é INCIDENTE.
# A busca é por "Accepted publickey|Accepted password" e não só "Accepted",
# porque "key type ssh-rsa not in PubkeyAcceptedAlgorithms" também contém a
# palavra e não é login (pegou a auditoria de 06/10 de surpresa).
accepted=$(ssh_lines | grep -E "Accepted (publickey|password|keyboard-interactive)")
if [ -z "$accepted" ]; then
  echo "nenhum login no período"
else
  echo "$accepted" | while read -r line; do
    fp=$(grep -oE 'SHA256:[A-Za-z0-9+/=]+' <<<"$line")
    ip=$(grep -oE 'from [0-9a-f.:]+' <<<"$line" | cut -d' ' -f2)
    method=$(grep -oE 'Accepted [a-z-]+' <<<"$line" | cut -d' ' -f2)
    who="${KNOWN_KEYS[$fp]:-⚠️ CHAVE DESCONHECIDA — INVESTIGAR}"
    [ "$method" != "publickey" ] && who="⚠️ LOGIN POR $method — INVESTIGAR"
    # Agrupa por DIA + IP + chave (cut -c1-6 = "Oct 06"): uma linha por
    # combinação, com a contagem na frente. Um deploy aparece como 2-4
    # logins do mesmo IP da Microsoft no mesmo dia; uma sessão sua, como
    # vários logins do seu IP.
    echo "$(cut -c1-6 <<<"$line")  $ip  $who"
  done | sort | uniq -c
fi

# ---------------------------------------------------------------------------
sec "2. TENTATIVAS DE LOGIN SSH (tentaram entrar?)"
# Ruído normal de internet: robôs testam usuários comuns (admin, ubuntu...)
# o dia todo. Com senha desligada eles NÃO conseguem entrar — isto mede o
# volume, não um risco imediato.
fails=$(ssh_lines | grep -Ei "invalid user|failed password|authentication failure|maximum authentication attempts")
echo "tentativas falhas: $(grep -c . <<<"$fails")"
echo "-- top IPs:"
grep -Eo "from [0-9a-f.:]+" <<<"$fails" | awk '{print $2}' | grep -v "^$MY_IP$" | sort | uniq -c | sort -rn | head -10
echo "-- usuários mais tentados:"
grep -Eio "invalid user [^ ]+" <<<"$fails" | awk '{print $3}' | sort | uniq -c | sort -rn | head -8

# ---------------------------------------------------------------------------
sec "3. SITE: VOLUME E SONDAGENS (Nginx)"
lines=$(nginx_lines)
echo "requisições: $(grep -c . <<<"$lines")   (seu IP: $(grep -c "^$MY_IP " <<<"$lines"))"
echo "-- status (sem o seu IP):"
grep -v "^$MY_IP " <<<"$lines" | awk '{print $9}' | sort | uniq -c | sort -rn | head -8
echo "-- top IPs estranhos:"
grep -v "^$MY_IP " <<<"$lines" | awk '{print $1}' | sort | uniq -c | sort -rn | head -10
echo "-- padrões de ataque (quantidade):"
for p in '\.env' '\.git/' 'wp-login|wp-admin|xmlrpc' 'phpunit|eval-stdin|\.php' '\.\./|%2e%2e' '/cgi-bin' 'union.*select|select.*from|%27' '<script|%3Cscript' 'invokefunction|allow_url_include' '/api/config|settings\.html'; do
  printf '%6s  %s\n' "$(grep -v "^$MY_IP " <<<"$lines" | grep -Eic "$p")" "$p"
done

# ---------------------------------------------------------------------------
sec "4. ⚠️ ESTRANHOS COM SUCESSO (2xx) EM ROTA SENSÍVEL"
# O SINAL DE ALERTA de verdade. Sondagem que dá 404 é ruído; um IP estranho
# recebendo 200 em /api/config, /settings.html ou /api/handoff é o que
# importa. Telegram/Meta nas rotas de webhook são esperados e filtrados.
hits=$(grep -v "^$MY_IP " <<<"$lines" \
  | awk '$9 ~ /^2/' \
  | grep -E '"(GET|POST|PUT|DELETE) /(api/|settings|handoff-app|webhook/(telegram|whatsapp))' \
  | grep -Ev "$LEGIT_PREFIX_REGEX")
if [ -z "$hits" ]; then
  echo "nenhum ✅"
else
  echo "$hits" | awk '{print $1, $4, $6, $7, $9}'
fi

# ---------------------------------------------------------------------------
sec "5. SAÚDE E ATUALIZAÇÃO DA VM"
[ -f /var/run/reboot-required ] && echo "⚠️ reboot pendente: $(tr '\n' ' ' </var/run/reboot-required.pkgs 2>/dev/null)" || echo "reboot pendente: não"
upd=$(sudo -n apt-get -s upgrade 2>/dev/null | grep '^Inst')
echo "updates pendentes: $(grep -c . <<<"$upd")  (de segurança: $(grep -ic secur <<<"$upd"))"
# Uma linha por certificado: nome + "Expiry Date: ... (VALID: N days)".
sudo -n certbot certificates 2>/dev/null | grep -E "Certificate Name|Expiry Date" | paste - - \
  | sed -E 's/ *Certificate Name: ([^ ]+) *Expiry Date: ([0-9-]+).*\((.*)\)/certificado: \1 expira \2 (\3)/'
echo "bloqueio da tela de config no Nginx: $(curl -s -o /dev/null -w '%{http_code}' -H 'Host: rizzato-tech.rizzatotech.com' https://127.0.0.1/settings.html -k) (esperado 404)"
pm2 jlist 2>/dev/null | node -e 'let d="";process.stdin.on("data",x=>d+=x).on("end",()=>{try{JSON.parse(d).forEach(p=>console.log("pm2:",p.name,p.pm2_env.status,"restarts="+p.pm2_env.restart_time))}catch{console.log("pm2: não foi possível ler")}})'
echo "memória: $(free -m | awk '/Mem:/{print $3"MB usados de "$2"MB"}')"
echo
echo "Fim. Como ler cada seção: docs/TUTORIAL_SEGURANCA_LOGS.md"
