#!/usr/bin/env bash
# =============================================================================
#  FreeScout Sync Manager - interactive installer (Ubuntu 22.04 / 24.04 / 26.04)
#  Installs the web app that backs up, syncs and migrates FreeScout instances.
#  Run from the unpacked folder:  sudo bash install.sh
# =============================================================================
set -Eeuo pipefail
trap 'echo -e "\n\033[1;31m[ERROR]\033[0m line $LINENO: \"$BASH_COMMAND\" failed. See $LOG" >&2' ERR

SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_HOME=/opt/fsmanager
SVC_USER=fsmanager
PORT=8080
LOG=/var/log/fsmanager-install.log
SSL_DIR=/etc/ssl/fsmanager
NODE_MIN=22.13
# Certificate details for the local CA (asked during install; blank fields are left out).
# Can be preset: sudo CERT_O="Example Inc" CERT_OU="IT" bash install.sh
CERT_O=${CERT_O-}; CERT_OU=${CERT_OU-}; CERT_L=${CERT_L-}; CERT_ST=${CERT_ST-}; CERT_C=${CERT_C:-US}
# Build "/C=../ST=../L=../O=../OU=.." leaving out blank fields ("/" in a value would split the subject)
subject_dn() { local out="" k v; for k in C ST L O OU; do v=${!k-}; v=${v//\//-}; [[ -n $v ]] && out+="/$k=$v"; done; printf '%s' "$out"; }
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

c_b='\033[1;34m'; c_g='\033[1;32m'; c_y='\033[1;33m'; c_r='\033[1;31m'; c_0='\033[0m'
step() { echo -e "\n${c_b}==>${c_0} $*"; echo "==> $*" >>"$LOG"; }
ok()   { echo -e "    ${c_g}✓${c_0} $*"; }
warn() { echo -e "    ${c_y}!${c_0} $*"; }
die()  { echo -e "${c_r}[FATAL]${c_0} $*" >&2; exit 1; }
run()  {
  local rc=0; "$@" >>"$LOG" 2>&1 || rc=$?
  if (( rc )); then echo -e "    ${c_r}✗${c_0} '$*' failed (exit $rc). Last lines of $LOG:" >&2; tail -n 12 "$LOG" | sed 's/^/      /' >&2; fi
  return $rc
}

if [[ -t 0 ]]; then TTY=/dev/stdin; elif [[ -r /dev/tty ]]; then TTY=/dev/tty; else die "No terminal for prompts."; fi
ask() { local p=$1 d=${2-} r; if [[ -n $d ]]; then read -r -p "  $p [$d]: " r <"$TTY"; else read -r -p "  $p: " r <"$TTY"; fi
  r="${r#"${r%%[![:space:]]*}"}"; r="${r%"${r##*[![:space:]]}"}"; printf '%s' "${r:-$d}"; }
ask_required() { local v=""; while [[ -z $v ]]; do v=$(ask "$@"); [[ -z $v ]] && echo "    (required)" >&2; done; printf '%s' "$v"; }
ask_yn() { local d=${2:-N} h r; [[ $d =~ ^[Yy] ]] && h="Y/n" || h="y/N"
  while true; do read -r -p "  $1 ($h): " r <"$TTY"; r=${r:-$d}; case ${r,,} in y|yes) return 0;; n|no) return 1;; *) echo "    Please answer y or n." >&2;; esac; done; }
ask_secret() { local a b m=${2:-10}; while true; do read -r -s -p "  $1: " a <"$TTY"; echo >&2
  (( ${#a} >= m )) || { echo "    At least $m characters." >&2; continue; }
  read -r -s -p "  Confirm: " b <"$TTY"; echo >&2; [[ $a == "$b" ]] && break; echo "    Entries do not match." >&2; done; printf '%s' "$a"; }
is_ip() { [[ $1 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }
is_domain() { [[ $1 =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; }

# ── pre-flight ──
[[ $EUID -eq 0 ]] || die "Run as root: sudo bash $0"
. /etc/os-release
[[ ${ID:-} == ubuntu ]] || die "Ubuntu only (found ${PRETTY_NAME:-unknown})."
[[ -f $SRC_DIR/app/package.json && -f $SRC_DIR/agent/fs-agent ]] || die "Run this from the unpacked fsmanager folder (app/ and agent/ must be next to install.sh)."
: >"$LOG"; chmod 600 "$LOG"
SERVER_IP=""; _r=$(ip -4 route get 1.1.1.1 2>/dev/null || true)
[[ $_r =~ src[[:space:]]+([0-9.]+) ]] && SERVER_IP=${BASH_REMATCH[1]}
[[ -n $SERVER_IP ]] || { _h=$(hostname -I 2>/dev/null || true); SERVER_IP=${_h%% *}; }
CUR_TZ=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)
UPGRADE=false; [[ -f /etc/systemd/system/fsmanager.service ]] && UPGRADE=true

cat <<EOF

 ##################################################
 ##     FreeScout Sync Manager installer         ##
 ##################################################
  Ubuntu ${VERSION_ID}, server IP ${SERVER_IP:-unknown}
  $($UPGRADE && echo "Existing install found - this will UPGRADE it (data and settings kept).")

EOF

if $UPGRADE; then
  # shellcheck disable=SC1091
  . /etc/fsmanager/install.conf 2>/dev/null || die "/etc/fsmanager/install.conf missing - cannot upgrade"
  ask_yn "Upgrade the app in $APP_HOME?" Y || exit 0
else
  echo -e "${c_b}-- Web address --${c_0}"
  while true; do
    DOMAIN=$(ask_required "Hostname for the manager (e.g. fsmanager.example.local)" "$(hostname -f 2>/dev/null || hostname)")
    DOMAIN=${DOMAIN,,}; is_domain "$DOMAIN" || is_ip "$DOMAIN" || [[ $DOMAIN =~ ^[a-z0-9-]+$ ]] && break
    echo "    Not a valid hostname." >&2
  done
  echo "   1) Self-signed: local CA + certificate (recommended for internal names)"
  echo "   2) Use my own certificate files (e.g. from your AD CS)"
  echo "   3) HTTP only (not recommended - passwords travel unencrypted)"
  while true; do TLS_MODE=$(ask "Choose 1-3" 1); [[ $TLS_MODE =~ ^[1-3]$ ]] && break; done
  OWN_CERT=""; OWN_KEY=""
  if [[ $TLS_MODE == 1 ]]; then
    echo "  Certificate details shown to users who inspect the certificate (blank = leave out):"
    CERT_O=$(ask "  Organization" "$CERT_O"); CERT_OU=$(ask "  Department" "$CERT_OU")
    CERT_L=$(ask "  City" "$CERT_L"); CERT_ST=$(ask "  State" "$CERT_ST")
    while true; do CERT_C=$(ask "  Country code" "$CERT_C"); [[ $CERT_C =~ ^[A-Za-z]{2}$ ]] && break; echo "    2 letters, e.g. US" >&2; done
    CERT_C=${CERT_C^^}
  fi
  if [[ $TLS_MODE == 2 ]]; then
    while true; do
      OWN_CERT=$(ask_required "Certificate file (PEM, full chain)"); OWN_KEY=$(ask_required "Private key file (PEM, unencrypted)")
      [[ -r $OWN_CERT && -r $OWN_KEY ]] || { echo "    Not readable." >&2; continue; }
      [[ $(openssl x509 -in "$OWN_CERT" -noout -pubkey 2>/dev/null | openssl sha256) == $(openssl pkey -in "$OWN_KEY" -pubout 2>/dev/null | openssl sha256) ]] && break
      echo "    Certificate and key do not match." >&2
    done
  fi
  echo -e "\n${c_b}-- Storage --${c_0}"
  echo "  Snapshots hold each instance's database and files (unchanged files are shared between snapshots)."
  DATA_DIR=$(ask "Where to keep data and backups" "/var/lib/fsmanager"); DATA_DIR=${DATA_DIR%/}
  [[ $DATA_DIR == /* && ! $DATA_DIR =~ ^/(|etc|usr|bin|boot|proc|sys|dev|root|home|var)$ ]] || die "Pick a dedicated absolute directory."
  echo -e "\n${c_b}-- Security --${c_0}"
  AGENT_FROM=""
  if [[ -n $SERVER_IP ]] && ask_yn "Lock agent SSH keys so they only work from this manager's IP (${SERVER_IP})?" Y; then AGENT_FROM=$SERVER_IP; fi
  while true; do TZV=$(ask "Time zone for schedules" "$CUR_TZ"); [[ -f /usr/share/zoneinfo/$TZV ]] && break; echo "    Unknown time zone." >&2; done
  ADMIN_USER=$(ask "Admin username" "admin")
  [[ $ADMIN_USER =~ ^[A-Za-z0-9._-]{2,64}$ ]] || die "Invalid username."
  ADMIN_PASS=$(ask_secret "Admin password (min 10 chars)" 10)
  echo
  ask_yn "Install now?" Y || die "Aborted - nothing changed."
fi

# ── packages ──
step "Installing packages"
run apt-get update
run apt-get install -y ca-certificates curl gnupg nginx rsync openssh-client openssl gzip
node_ok() { command -v node >/dev/null && dpkg --compare-versions "$(node -v | tr -d v)" ge "$NODE_MIN"; }
if ! node_ok; then
  cand=$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/ {print $2}' | sed 's/^[0-9]*://; s/[-~+].*//')
  if [[ -n $cand && $cand != "(none)" ]] && dpkg --compare-versions "$cand" ge "$NODE_MIN"; then
    run apt-get install -y nodejs npm; ok "Node.js from Ubuntu ($cand)"
  else
    warn "Ubuntu's Node.js (${cand:-none}) is older than $NODE_MIN - adding the NodeSource Node.js 24 LTS repository"
    curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh || die "Could not download the NodeSource setup script"
    run bash /tmp/nodesource_setup.sh; rm -f /tmp/nodesource_setup.sh
    run apt-get install -y nodejs
  fi
fi
node_ok || die "Node.js $NODE_MIN or newer is required (found $(node -v 2>/dev/null || echo none))."
NODE_BIN=$(command -v node)
ok "Node.js $(node -v) at $NODE_BIN, npm $(npm -v)"

# ── app files ──
step "Installing the application"
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
install -d -m 700 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR"
$UPGRADE && systemctl stop fsmanager >>"$LOG" 2>&1 || true
mkdir -p "$APP_HOME"
rsync -a --delete --exclude node_modules "$SRC_DIR/app/" "$APP_HOME/app/"
rsync -a --delete "$SRC_DIR/agent/" "$APP_HOME/agent/"
chown -R root:root "$APP_HOME"; chmod -R go-w "$APP_HOME"
cd "$APP_HOME/app"
if [[ ! -f dist/server.js ]]; then
  run npm ci --no-audit --no-fund || die "npm install failed"
  run npm run build || die "build failed"
  run npm prune --omit=dev
else
  run npm ci --omit=dev --no-audit --no-fund || die "npm install failed - check access to registry.npmjs.org"
fi
ok "app installed in $APP_HOME"

# ── service ──
mkdir -p /etc/fsmanager
if ! $UPGRADE; then
  cat >/etc/fsmanager/install.conf <<EOF
DOMAIN=$DOMAIN
DATA_DIR=$DATA_DIR
TLS_MODE=$TLS_MODE
EOF
  timedatectl set-timezone "$TZV" >>"$LOG" 2>&1 || ln -sf "/usr/share/zoneinfo/$TZV" /etc/localtime
fi
cat >/etc/systemd/system/fsmanager.service <<EOF
[Unit]
Description=FreeScout Sync Manager
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC_USER
Group=$SVC_USER
Environment=NODE_ENV=production
Environment=FSM_DATA=$DATA_DIR
Environment=FSM_PORT=$PORT
Environment=FSM_BIND=127.0.0.1
Environment=HOME=$DATA_DIR
WorkingDirectory=$APP_HOME/app
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning $APP_HOME/app/dist/server.js
Restart=on-failure
RestartSec=5
# hardening
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$DATA_DIR
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
cli() { (umask 077; cd "$APP_HOME/app" && runuser -u "$SVC_USER" -- env FSM_DATA="$DATA_DIR" HOME="$DATA_DIR" node --disable-warning=ExperimentalWarning dist/cli.js "$@"); }
if ! $UPGRADE; then
  printf '%s\n' "$ADMIN_PASS" | cli set-password "$ADMIN_USER" >>"$LOG" 2>&1 || die "could not create the admin account"
  unset ADMIN_PASS
  cli set-setting agent_from "$AGENT_FROM" >>"$LOG" 2>&1
fi
systemctl daemon-reload
systemctl enable fsmanager >>"$LOG" 2>&1
systemctl restart fsmanager
for _ in $(seq 1 20); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/agent/install.sh" && break; sleep 1; done
curl -fs -o /dev/null "http://127.0.0.1:$PORT/agent/install.sh" || die "service did not start - run: journalctl -u fsmanager -n 50"
ok "fsmanager.service running"

# ── TLS + nginx ──
if ! $UPGRADE; then
  step "Configuring HTTPS and Nginx"
  install -d -m 755 "$SSL_DIR"
  CERT=""; KEY=""
  if [[ $TLS_MODE == 1 ]]; then
    if [[ ! -f $SSL_DIR/fsmanager-ca.key ]]; then
      (umask 077; openssl genrsa -out "$SSL_DIR/fsmanager-ca.key" 4096 >>"$LOG" 2>&1)
      openssl req -x509 -new -key "$SSL_DIR/fsmanager-ca.key" -sha256 -days 3650 -out "$SSL_DIR/fsmanager-ca.crt" \
        -subj "$(C=$CERT_C ST=$CERT_ST L=$CERT_L O=$CERT_O OU=$CERT_OU subject_dn)/CN=${CERT_O:+$CERT_O }Sync Manager Local CA" -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
        -addext "keyUsage=critical,keyCertSign,cRLSign" >>"$LOG" 2>&1
    fi
    SAN="DNS:$DOMAIN"; is_ip "$DOMAIN" && SAN="IP:$DOMAIN"
    if ! is_ip "$DOMAIN" && [[ $DOMAIN == *.* ]]; then SAN="$SAN,DNS:${DOMAIN%%.*}"; fi
    for _ip in $SERVER_IP $(hostname -I 2>/dev/null); do is_ip "$_ip" && [[ $_ip != "$DOMAIN" && ",$SAN," != *",IP:$_ip,"* ]] && SAN="$SAN,IP:$_ip"; done
    (umask 077; openssl genrsa -out "$SSL_DIR/server.key" 2048 >>"$LOG" 2>&1)
    openssl req -new -key "$SSL_DIR/server.key" -subj "$(C=$CERT_C ST=$CERT_ST L=$CERT_L O=$CERT_O OU=$CERT_OU subject_dn)/CN=$DOMAIN" -out "$SSL_DIR/server.csr" >>"$LOG" 2>&1
    printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n' "$SAN" >"$SSL_DIR/server.ext"
    openssl x509 -req -in "$SSL_DIR/server.csr" -CA "$SSL_DIR/fsmanager-ca.crt" -CAkey "$SSL_DIR/fsmanager-ca.key" -CAcreateserial \
      -out "$SSL_DIR/server.leaf.crt" -days 820 -sha256 -extfile "$SSL_DIR/server.ext" >>"$LOG" 2>&1
    cat "$SSL_DIR/server.leaf.crt" "$SSL_DIR/fsmanager-ca.crt" >"$SSL_DIR/server.crt"
    chmod 644 "$SSL_DIR/server.crt" "$SSL_DIR/fsmanager-ca.crt"
    CERT=$SSL_DIR/server.crt; KEY=$SSL_DIR/server.key
    ok "certificate for $SAN"
  elif [[ $TLS_MODE == 2 ]]; then
    install -m 644 "$OWN_CERT" "$SSL_DIR/server.crt"; install -m 600 "$OWN_KEY" "$SSL_DIR/server.key"
    CERT=$SSL_DIR/server.crt; KEY=$SSL_DIR/server.key
  fi
  V6=""; [[ -f /proc/net/if_inet6 ]] && V6=yes
  PROXY="    client_max_body_size 1m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
    }"
  {
    echo "# Managed by FreeScout Sync Manager installer"
    echo "server {"
    echo "    listen 80;"; [[ -n $V6 ]] && echo "    listen [::]:80;"
    echo "    server_name $DOMAIN $SERVER_IP;"
    if [[ $TLS_MODE == 1 ]]; then echo "    location = /fsmanager-ca.crt { alias $SSL_DIR/fsmanager-ca.crt; default_type application/x-x509-ca-cert; }"; fi
    if [[ $TLS_MODE == 3 ]]; then echo "$PROXY"; else echo "    location / { return 301 https://\$host\$request_uri; }"; fi
    echo "}"
    if [[ $TLS_MODE != 3 ]]; then
      echo "server {"
      echo "    listen 443 ssl;"; [[ -n $V6 ]] && echo "    listen [::]:443 ssl;"
      echo "    server_name $DOMAIN $SERVER_IP;"
      echo "    ssl_certificate $CERT;"; echo "    ssl_certificate_key $KEY;"
      echo "    ssl_protocols TLSv1.2 TLSv1.3;"; echo "    ssl_session_tickets off;"
      echo "    add_header Strict-Transport-Security \"max-age=31536000\" always;"
      echo "$PROXY"
      echo "}"
    fi
  } >/etc/nginx/sites-available/fsmanager.conf
  ln -sf /etc/nginx/sites-available/fsmanager.conf /etc/nginx/sites-enabled/fsmanager.conf
  if [[ -L /etc/nginx/sites-enabled/default ]] && ask_yn "Disable nginx's default site (recommended on a dedicated server)?" Y; then rm -f /etc/nginx/sites-enabled/default; fi
  nginx -t >>"$LOG" 2>&1 || { nginx -t; die "nginx config test failed"; }
  systemctl enable nginx >>"$LOG" 2>&1; systemctl restart nginx
  pgrep -x nginx >/dev/null || die "nginx failed to start"
  ok "nginx site /etc/nginx/sites-available/fsmanager.conf"
  if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then run ufw allow 80/tcp; [[ $TLS_MODE != 3 ]] && run ufw allow 443/tcp; ok "firewall opened"; fi
  if ! is_ip "$DOMAIN" && ! getent hosts "$DOMAIN" >/dev/null; then echo "${SERVER_IP:-127.0.0.1} $DOMAIN  # fsmanager" >>/etc/hosts; fi
fi

# ── summary ──
# shellcheck disable=SC1091
. /etc/fsmanager/install.conf
PROTO=https; [[ $TLS_MODE == 3 ]] && PROTO=http
echo -e "\n${c_g}############################################################"
echo -e "##   FreeScout Sync Manager is ready                      ##"
echo -e "############################################################${c_0}"
echo "  Open:        $PROTO://$DOMAIN"
$UPGRADE || echo "  Sign in as:  $ADMIN_USER"
echo "  Data:        $DATA_DIR  (database, SSH key, snapshots, logs)"
echo "  Service:     systemctl status fsmanager   |   journalctl -u fsmanager"
[[ $TLS_MODE == 1 ]] && echo "  Trust the CA on your PCs: http://$DOMAIN/fsmanager-ca.crt (Trusted Root Certification Authorities)"
echo
echo "  Next: in the web app, open Instances > Add instance and run the agent"
echo "  install command on each FreeScout server."
echo
