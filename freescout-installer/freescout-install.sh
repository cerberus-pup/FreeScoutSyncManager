#!/usr/bin/env bash
# =============================================================================
#  FreeScout interactive installer for Ubuntu Server 22.04 / 24.04 / 26.04
# -----------------------------------------------------------------------------
#  Fixes over the upstream tools/install.sh:
#   * Prompts read from /dev/tty, so it works with  curl ... | sudo bash  too
#   * y/n answers are case-insensitive; empty answers use the shown default
#   * All questions are asked up front; then it runs unattended
#   * Never installs PHP 8.1 (FreeScout warns against it) - uses the
#     ondrej/php PPA for PHP 8.3 on Ubuntu 22.04
#   * MariaDB with idempotent CREATE USER / GRANT (no "expected" SQL errors)
#   * Supports .local / internal domains and bare IPs
#   * HTTPS options: local CA + signed cert, your own cert (e.g. AD CS),
#     Let's Encrypt (public names only), or plain HTTP
#   * Optionally finishes the install from the CLI (no web installer needed)
#   * Cron in /etc/cron.d, PHP limits in conf.d drop-ins, safe to re-run
#
#  Usage:  sudo bash freescout-install.sh
# =============================================================================

set -Eeuo pipefail
trap 'echo -e "\n\033[1;31m[ERROR]\033[0m Line $LINENO: \"$BASH_COMMAND\" failed (exit $?). See $LOG" >&2' ERR

LOG=/var/log/freescout-install.log
REPO_URL="https://github.com/freescout-help-desk/freescout.git"
SSL_DIR=/etc/ssl/freescout
ACME_ROOT=/var/www/letsencrypt
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a          # stop needrestart's whiptail prompt on 22.04+

# ---------- output helpers ---------------------------------------------------
c_blue='\033[1;34m'; c_green='\033[1;32m'; c_yellow='\033[1;33m'; c_red='\033[1;31m'; c_off='\033[0m'
step() { echo -e "\n${c_blue}==>${c_off} $*"; echo "==> $*" >>"$LOG"; }
ok()   { echo -e "    ${c_green}✓${c_off} $*"; }
warn() { echo -e "    ${c_yellow}!${c_off} $*"; }
die()  { echo -e "${c_red}[FATAL]${c_off} $*" >&2; exit 1; }
run()  {   # quiet command, output goes to the log; on failure show what failed
  local rc=0
  "$@" >>"$LOG" 2>&1 || rc=$?
  if (( rc )); then
    echo -e "    ${c_red}✗${c_off} '$*' failed (exit $rc). Last lines of $LOG:" >&2
    tail -n 12 "$LOG" | sed 's/^/      /' >&2
  fi
  return $rc
}

# ---------- prompt helpers (always read from the terminal) -------------------
if [[ -t 0 ]]; then TTY=/dev/stdin
elif [[ -r /dev/tty ]]; then TTY=/dev/tty
else die "No terminal available for prompts. Download the script and run: sudo bash freescout-install.sh"; fi

ask() {   # ask "Prompt" "default"  -> echoes answer
  local prompt=$1 default=${2-} reply
  if [[ -n $default ]]; then read -r -p "  $prompt [$default]: " reply <"$TTY"
  else read -r -p "  $prompt: " reply <"$TTY"; fi
  reply="${reply#"${reply%%[![:space:]]*}"}"; reply="${reply%"${reply##*[![:space:]]}"}"
  printf '%s' "${reply:-$default}"
}
# Build "/C=../ST=../L=../O=../OU=.." leaving out blank fields ("/" in a value would split the subject)
subject_dn() { local out="" k v; for k in C ST L O OU; do v=${!k-}; v=${v//\//-}; [[ -n $v ]] && out+="/$k=$v"; done; printf '%s' "$out"; }
ask_required() { local v=""; while [[ -z $v ]]; do v=$(ask "$@"); [[ -z $v ]] && echo "    (required)" >&2; done; printf '%s' "$v"; }
ask_yn() {   # ask_yn "Question" Y|N  -> return 0 for yes
  local def=${2:-N} hint reply
  [[ $def =~ ^[Yy] ]] && hint="Y/n" || hint="y/N"
  while true; do
    read -r -p "  $1 ($hint): " reply <"$TTY"; reply=${reply:-$def}
    case ${reply,,} in y|yes) return 0;; n|no) return 1;; *) echo "    Please answer y or n." >&2;; esac
  done
}
ask_secret() {   # ask_secret "Prompt" minlen -> echoes secret
  local p1 p2 min=${2:-8}
  while true; do
    read -r -s -p "  $1: " p1 <"$TTY"; echo >&2
    if (( ${#p1} < min )); then echo "    Must be at least $min characters." >&2; continue; fi
    read -r -s -p "  Confirm: " p2 <"$TTY"; echo >&2
    [[ $p1 == "$p2" ]] && break; echo "    Entries do not match." >&2
  done
  printf '%s' "$p1"
}

pkg_available() { local out; out=$(apt-cache show "$1" 2>/dev/null || true); grep -q '^Version:' <<<"$out"; }
is_ip()     { [[ $1 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }
is_domain() { [[ $1 =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; }
is_private_name() { [[ $1 =~ \.(local|lan|internal|home|corp|localdomain|test|intranet|home\.arpa)$ ]] || is_ip "$1"; }

# =============================================================================
#  Pre-flight
# =============================================================================
[[ $EUID -eq 0 ]] || die "Run as root:  sudo bash $0"
[[ -r /etc/os-release ]] || die "Cannot detect OS."
# shellcheck disable=SC1091
. /etc/os-release
[[ ${ID:-} == ubuntu ]] || die "This installer is for Ubuntu (detected: ${PRETTY_NAME:-unknown})."
case ${VERSION_ID:-} in
  22.04|24.04|26.04) ;;
  *) warn "Untested Ubuntu release ${VERSION_ID}. Supported: 22.04, 24.04, 26.04."
     ask_yn "Continue anyway?" N || exit 1 ;;
esac
: >"$LOG"; chmod 600 "$LOG"

SERVER_IP=""
_route=$(ip -4 route get 1.1.1.1 2>/dev/null || true)
[[ $_route =~ src[[:space:]]+([0-9.]+) ]] && SERVER_IP=${BASH_REMATCH[1]}
if [[ -z $SERVER_IP ]]; then _hi=$(hostname -I 2>/dev/null || true); SERVER_IP=${_hi%% *}; fi
SERVER_IP=${SERVER_IP:-127.0.0.1}
CUR_TZ=$(timedatectl show -p Timezone --value 2>/dev/null || true)
[[ -n $CUR_TZ ]] || CUR_TZ=$(cat /etc/timezone 2>/dev/null || true)
[[ -n $CUR_TZ ]] || CUR_TZ=$(readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||' || true)
CUR_TZ=${CUR_TZ:-UTC}

cat <<EOF

 ##################################################
 ##     FreeScout Installer (Ubuntu ${VERSION_ID})        ##
 ##################################################
  Server IP detected: ${SERVER_IP}
  Installs: Nginx, PHP-FPM, MariaDB, FreeScout, cron, HTTPS
  Log file: ${LOG}

EOF

# =============================================================================
#  Questions (all asked up front)
# =============================================================================
echo -e "${c_blue}-- Site --${c_off}"
while true; do
  DOMAIN=$(ask_required "Help desk hostname (e.g. helpdesk.example.local or helpdesk.example.com)")
  DOMAIN=${DOMAIN,,}; DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN%%/*}
  if is_domain "$DOMAIN" || is_ip "$DOMAIN"; then break; fi
  echo "    '$DOMAIN' is not a valid hostname or IPv4 address." >&2
done

INSTALL_DIR=$(ask "Install directory" "/var/www/freescout")
INSTALL_DIR=${INSTALL_DIR%/}
[[ $INSTALL_DIR == /* ]] || die "Install directory must be an absolute path."
[[ $INSTALL_DIR =~ ^/(|bin|boot|dev|etc|home|lib|lib64|opt|proc|root|run|sbin|srv|sys|tmp|usr|var|var/www)$ ]] \
  && die "Refusing to use $INSTALL_DIR - pick a dedicated directory."

echo -e "\n${c_blue}-- HTTPS --${c_off}"
if is_private_name "$DOMAIN"; then
  echo "  '$DOMAIN' is an internal name/IP - public CAs (Let's Encrypt) can't issue for it."
  DEFAULT_TLS=1
else
  DEFAULT_TLS=3
fi
cat <<EOF
   1) Self-signed: create a local CA and sign a server cert with it (recommended for .local)
      - import the CA once on clients (or push via GPO) and the browser trusts it
   2) Use my own certificate files (e.g. issued by your internal AD CS / other CA)
   3) Let's Encrypt (public DNS name that resolves to this server from the internet)
   4) No HTTPS (HTTP only - browser push notifications and mobile apps won't work)
EOF
while true; do TLS_MODE=$(ask "Choose 1-4" "$DEFAULT_TLS"); [[ $TLS_MODE =~ ^[1-4]$ ]] && break; done

EXTRA_SANS=""; CERT_DAYS=820; CERT_O=${CERT_O-}; CERT_OU=${CERT_OU-}; CERT_L=${CERT_L-}; CERT_ST=${CERT_ST-}; CERT_C=${CERT_C:-US}; OWN_CERT=""; OWN_KEY=""; LE_EMAIL=""
case $TLS_MODE in
  1)
    EXTRA_SANS=$(ask "Extra names/IPs for the cert, comma-separated (blank = none). ${SERVER_IP} is always added" "")
    CERT_DAYS=$(ask "Server cert validity in days (Safari/macOS reject private certs over 825)" "820")
    [[ $CERT_DAYS =~ ^[0-9]+$ ]] && (( CERT_DAYS <= 825 )) || CERT_DAYS=820
    echo "  Certificate details shown to users who inspect the certificate (blank = leave out):"
    CERT_O=$(ask "  Organization" "$CERT_O"); CERT_OU=$(ask "  Department" "$CERT_OU")
    CERT_L=$(ask "  City" "$CERT_L"); CERT_ST=$(ask "  State" "$CERT_ST")
    while true; do CERT_C=$(ask "  Country code" "$CERT_C"); [[ $CERT_C =~ ^[A-Za-z]{2}$ ]] && break; echo "    2 letters, e.g. US" >&2; done
    CERT_C=${CERT_C^^}
    ;;
  2)
    while true; do
      OWN_CERT=$(ask_required "Path to certificate (PEM, full chain: server cert first, then intermediates)")
      OWN_KEY=$(ask_required "Path to private key (PEM, unencrypted)")
      [[ -r $OWN_CERT && -r $OWN_KEY ]] || { echo "    One of those files isn't readable." >&2; continue; }
      if [[ $(openssl x509 -in "$OWN_CERT" -noout -pubkey 2>/dev/null | openssl sha256) == \
            $(openssl pkey -in "$OWN_KEY" -pubout 2>/dev/null | openssl sha256) ]]; then ok "Certificate and key match"; break
      else echo "    Certificate and key do not match (or key is encrypted)." >&2; fi
    done
    ;;
  3)
    is_private_name "$DOMAIN" && warn "Let's Encrypt will almost certainly fail for '$DOMAIN'."
    LE_EMAIL=$(ask_required "Email for Let's Encrypt expiry notices")
    ;;
esac
[[ $TLS_MODE == 4 ]] && PROTO=http || PROTO=https

MDNS=false
if [[ $DOMAIN == *.local ]]; then
  echo
  echo "  Note: .local is the mDNS (Bonjour) suffix. Clients resolve it either from your"
  echo "  internal DNS (e.g. an A record in AD DNS for $DOMAIN -> $SERVER_IP) or via mDNS."
  ask_yn "Also announce $DOMAIN on the LAN via mDNS (Avahi)? Pick 'n' if you'll add a DNS record" N && MDNS=true
fi

echo -e "\n${c_blue}-- Application --${c_off}"
while true; do
  APP_TZ=$(ask "Timezone" "$CUR_TZ")
  [[ -f /usr/share/zoneinfo/$APP_TZ ]] && break; echo "    Unknown timezone (e.g. America/Los_Angeles)." >&2
done
MAX_MB=$(ask "Max attachment upload size in MB" "32"); [[ $MAX_MB =~ ^[0-9]+$ ]] || MAX_MB=32
WHITELIST=$(ask "Internal hosts FreeScout must connect to (e.g. on-prem mail server), comma-separated, blank = none" "")

# ---------- PHP security policy ----------------------------------------------
# Only install a PHP branch that still gets upstream security fixes, with at
# least MIN_SUPPORT_DAYS left. Dates from https://www.php.net/supported-versions.php
# (8.1 and older are end-of-life; FreeScout also says never use 8.1).
echo -e "\n${c_blue}-- PHP --${c_off}"
declare -A PHP_EOL=( [8.2]=2026-12-31 [8.3]=2027-12-31 [8.4]=2028-12-31 [8.5]=2029-12-31 )
PPA_PREFERRED=8.4
MIN_SUPPORT_DAYS=90
days_left() { echo $(( ( $(date -d "${PHP_EOL[$1]}" +%s) - $(date +%s) ) / 86400 )); }
branch_ok() { [[ -n ${PHP_EOL[$1]:-} ]] && (( $(days_left "$1") >= MIN_SUPPORT_DAYS )); }

case $VERSION_ID in 22.04) DISTRO_PHP=8.1;; 24.04) DISTRO_PHP=8.3;; 26.04) DISTRO_PHP=8.5;; *) DISTRO_PHP="";; esac
_dp=$(apt-cache depends php-fpm 2>/dev/null | grep -oE 'php[0-9]+\.[0-9]+-fpm' | head -1 | grep -oE '[0-9]+\.[0-9]+' || true)
[[ -n $_dp ]] && DISTRO_PHP=$_dp

PPA_PHP=""
if branch_ok "$PPA_PREFERRED"; then PPA_PHP=$PPA_PREFERRED
else for b in 8.5 8.4 8.3; do branch_ok "$b" && { PPA_PHP=$b; break; }; done; fi
# ppa:ondrej/php only publishes for some Ubuntu releases - check before offering it
PPA_URL="https://ppa.launchpadcontent.net/ondrej/php/ubuntu/dists/${VERSION_CODENAME}/Release"
if command -v curl >/dev/null 2>&1; then
  if ! curl -fsS --max-time 15 -o /dev/null "$PPA_URL" 2>/dev/null; then
    warn "ppa:ondrej/php has no packages for Ubuntu ${VERSION_ID} (${VERSION_CODENAME}) - PPA option disabled."
    PPA_PHP=""
  fi
fi

if [[ -n $DISTRO_PHP ]] && branch_ok "$DISTRO_PHP"; then
  echo "  Ubuntu's PHP ${DISTRO_PHP} is supported upstream until ${PHP_EOL[$DISTRO_PHP]} ($(days_left "$DISTRO_PHP") days)."
  echo "   1) Ubuntu's PHP ${DISTRO_PHP} - Canonical backports security fixes; the version number"
  echo "      stays ${DISTRO_PHP}.x-0ubuntu... (scanners that only read version strings may false-flag it)"
  [[ -n $PPA_PHP ]] && echo "   2) ppa:ondrej/php PHP ${PPA_PHP} - latest upstream point release (e.g. ${PPA_PHP}.NN)"
  while true; do PHP_SRC=$(ask "Choose" "1"); [[ $PHP_SRC == 1 || ( $PHP_SRC == 2 && -n $PPA_PHP ) ]] && break; done
else
  echo "  Ubuntu's PHP ${DISTRO_PHP:-?} is end-of-life upstream (or within ${MIN_SUPPORT_DAYS} days of it) - it won't be used."
  [[ -n $PPA_PHP ]] || die "Ubuntu's PHP is unsupported and ppa:ondrej/php is unavailable for ${VERSION_CODENAME}. Use a newer Ubuntu LTS (24.04/26.04)."
  echo "  Using ppa:ondrej/php PHP ${PPA_PHP} (supported until ${PHP_EOL[$PPA_PHP]})."
  PHP_SRC=2
fi
if [[ $PHP_SRC == 1 ]]; then PHPV=$DISTRO_PHP; USE_PPA=false; else PHPV=$PPA_PHP; USE_PPA=true; fi

# Other PHP branches already on this server (e.g. 8.1 left by the upstream installer)
OLD_PHP=()
while read -r pkg; do
  b=${pkg#php}; b=${b%-common}
  [[ $b != "$PHPV" ]] && ! branch_ok "$b" && OLD_PHP+=("$b")
done < <(dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n' 'php*-common' 2>/dev/null | awk '$1 ~ /^ii/ {print $2}' | grep -E '^php[0-9]+\.[0-9]+-common$' || true)
REMOVE_OLD_PHP=false
if (( ${#OLD_PHP[@]} )); then
  warn "Unsupported PHP already installed: ${OLD_PHP[*]}"
  ask_yn "Remove it? (n = keep packages but stop/disable its PHP-FPM service)" Y && REMOVE_OLD_PHP=true
fi

AUTO_SEC=true
ask_yn "Enable automatic security updates (unattended-upgrades) so PHP stays patched?" Y || AUTO_SEC=false

echo -e "\n${c_blue}-- Setup method --${c_off}"
echo "   1) Finish setup here from the command line (creates DB tables + admin user)  [recommended]"
echo "   2) Leave it for the web installer at ${PROTO}://${DOMAIN}/install"
while true; do SETUP_MODE=$(ask "Choose 1-2" "1"); [[ $SETUP_MODE =~ ^[12]$ ]] && break; done
if [[ $SETUP_MODE == 1 ]]; then
  ADMIN_FIRST=$(ask_required "Admin first name")
  ADMIN_LAST=$(ask_required "Admin last name")
  while true; do
    ADMIN_EMAIL=$(ask_required "Admin email (login)")
    [[ $ADMIN_EMAIL =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] && break; echo "    Invalid email." >&2
  done
  ADMIN_PASS=$(ask_secret "Admin password (min 8 chars)" 8)
fi

AUTO_UPDATE=false
ask_yn "Enable nightly automatic FreeScout updates (tools/update.sh at 01:00)?" N && AUTO_UPDATE=true

DB_NAME=freescout; DB_USER=freescout
DB_PASS=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32)

# Existing database server? (the upstream script installs mysql-server - keep it if present)
if dpkg -s mysql-server >/dev/null 2>&1; then
  DB_PKGS=(); DB_SERVICE=mysql; SQL_CLI=mysql
  echo; warn "MySQL server is already installed - it will be used instead of MariaDB."
else
  DB_PKGS=(mariadb-server mariadb-client); DB_SERVICE=mariadb; SQL_CLI=mariadb
fi
DROP_DB=false
if command -v "$SQL_CLI" >/dev/null 2>&1; then
  systemctl start "$DB_SERVICE" >/dev/null 2>&1 || true   # so an existing DB is detected
  EXISTING=$("$SQL_CLI" -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DB_NAME}';" 2>/dev/null || echo 0)
  if (( EXISTING > 0 )); then
    echo; warn "Database '${DB_NAME}' already exists with ${EXISTING} tables."
    ask_yn "Drop it and start fresh? (n = keep existing data and reuse it)" N && DROP_DB=true
  fi
fi

APACHE_ACTION=none
if dpkg -s apache2 >/dev/null 2>&1; then
  echo; warn "Apache is installed and would block port 80."
  ask_yn "Remove apache2? (n = just stop and disable it)" Y && APACHE_ACTION=purge || APACHE_ACTION=disable
fi

# Existing install / database?
WIPE_DIR=false
if [[ -d $INSTALL_DIR ]] && [[ -n $(ls -A "$INSTALL_DIR" 2>/dev/null) ]]; then
  echo; warn "$INSTALL_DIR is not empty."
  echo "  Type DELETE to wipe it and continue, anything else to abort:"
  [[ $(ask "Confirm" "") == DELETE ]] || die "Aborted - nothing was changed."
  WIPE_DIR=true
fi

cat <<EOF

 ------------------------------------------------------------
  Hostname     : ${DOMAIN}   (${PROTO}://${DOMAIN})
  Install dir  : ${INSTALL_DIR}
  HTTPS        : $(case $TLS_MODE in 1) echo "local CA + signed cert";; 2) echo "own cert: $OWN_CERT";; 3) echo "Let's Encrypt";; 4) echo "none";; esac)
  mDNS         : ${MDNS}
  Timezone     : ${APP_TZ}
  Upload limit : ${MAX_MB} MB
  Setup        : $([[ $SETUP_MODE == 1 ]] && echo "CLI, admin ${ADMIN_EMAIL}" || echo "web installer")
  Auto-update  : ${AUTO_UPDATE} (FreeScout)
  PHP          : ${PHPV} from $($USE_PPA && echo "ppa:ondrej/php" || echo "Ubuntu archive"), supported until ${PHP_EOL[$PHPV]}
  Security upd.: ${AUTO_SEC}
 ------------------------------------------------------------
EOF
ask_yn "Start installation?" Y || die "Aborted - nothing was changed."

# =============================================================================
#  1. Packages
# =============================================================================
step "Updating package lists and installing base tools"
run apt-get update
run apt-get install -y ca-certificates curl git unzip openssl cron software-properties-common
systemctl enable --now cron >>"$LOG" 2>&1 || true

case $APACHE_ACTION in
  purge)   step "Removing apache2"; run apt-get purge -y 'apache2*'; ok "apache2 removed" ;;
  disable) step "Disabling apache2"; run systemctl disable --now apache2; ok "apache2 stopped and disabled" ;;
esac

step "Installing Nginx and database server"
# On hosts with IPv6 disabled the stock 'default' site ([::]:80) stops nginx from
# starting and dpkg reports an error - drop that site and finish configuring.
if ! run apt-get install -y nginx "${DB_PKGS[@]}"; then
  rm -f /etc/nginx/sites-enabled/default
  run dpkg --configure -a || die "Package installation failed - see $LOG"
fi
rm -f /etc/nginx/sites-enabled/default
systemctl enable --now "$DB_SERVICE" >>"$LOG" 2>&1
systemctl enable nginx >>"$LOG" 2>&1
ok "nginx $(nginx -v 2>&1 | cut -d/ -f2), $("$SQL_CLI" --version | head -1)"

step "Installing PHP ${PHPV} ($($USE_PPA && echo "ppa:ondrej/php" || echo "Ubuntu archive"))"
branch_ok "$PHPV" || die "PHP ${PHPV} is not within upstream security support - refusing to install."
# Security fixes for Ubuntu's PHP arrive through the -security pocket - it must be enabled
APT_POLICY=$(apt-cache policy 2>/dev/null || true)
grep -q "a=${VERSION_CODENAME}-security" <<<"$APT_POLICY" \
  || die "The ${VERSION_CODENAME}-security repository is not enabled in APT sources - PHP would not get security fixes."
ok "${VERSION_CODENAME}-security repository is enabled"
if $USE_PPA; then
  if run add-apt-repository -y ppa:ondrej/php && run apt-get update \
     && pkg_available "php${PHPV}-fpm"; then
    ok "ppa:ondrej/php added"
  else
    warn "ppa:ondrej/php is not usable on ${VERSION_CODENAME} - removing it"
    add-apt-repository -y --remove ppa:ondrej/php >>"$LOG" 2>&1 || true
    rm -f /etc/apt/sources.list.d/ondrej-ubuntu-php-* /etc/apt/sources.list.d/ondrej-*php*
    run apt-get update || die "apt-get update still fails - check /etc/apt/sources.list.d/"
    if [[ -n $DISTRO_PHP ]] && branch_ok "$DISTRO_PHP"; then
      PHPV=$DISTRO_PHP; USE_PPA=false
      warn "Falling back to Ubuntu's PHP ${PHPV} (security-supported until ${PHP_EOL[$PHPV]})"
    else
      die "No security-supported PHP available for ${VERSION_CODENAME}."
    fi
  fi
fi
PHP_PKGS=()
for ext in fpm cli common mysql mbstring xml zip gd curl intl; do PHP_PKGS+=("php${PHPV}-${ext}"); done
# Optional extensions. IMAP was unbundled from PHP 8.4+ (PECL) and isn't packaged for
# every release; FreeScout no longer requires it (it uses a pure-PHP IMAP library).
for ext in imap bcmath; do
  if pkg_available "php${PHPV}-${ext}"; then PHP_PKGS+=("php${PHPV}-${ext}")
  elif pkg_available "php-${ext}" && grep -q "php${PHPV}" <<<"$(apt-cache depends "php-${ext}" 2>/dev/null || true)"; then PHP_PKGS+=("php-${ext}")
  else warn "Optional PHP extension '${ext}' isn't packaged for PHP ${PHPV} on ${VERSION_CODENAME} - skipping (not required by FreeScout)"; fi
done
run apt-get install -y "${PHP_PKGS[@]}" || die "Failed to install PHP ${PHPV} packages - see $LOG"

# Bring every installed php${PHPV} package (incl. pulled-in deps) to the newest patched build,
# then prove nothing is older than what the repositories offer.
mapfile -t PHP_INSTALLED < <({ dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n' "php${PHPV}*" 2>/dev/null || true; } | awk '$1 ~ /^ii/ {print $2}')
run apt-get install -y --only-upgrade "${PHP_INSTALLED[@]}" || die "Failed to upgrade PHP packages - see $LOG"
STALE=()
for p in "${PHP_INSTALLED[@]}"; do
  inst=$(dpkg-query -W -f='${Version}' "$p" 2>/dev/null || true)
  cand=$(apt-cache policy "$p" | awk '/Candidate:/ {print $2}')
  [[ -n $inst && $cand != "(none)" && $inst != "$cand" ]] && STALE+=("$p $inst (available: $cand)")
done
(( ${#STALE[@]} == 0 )) || die "PHP packages are not at the latest patched build: ${STALE[*]}"
PHP_PKG_VER=$(dpkg-query -W -f='${Version}' "php${PHPV}-fpm")
ok "All $(( ${#PHP_INSTALLED[@]} )) php${PHPV} packages are at the newest available build (${PHP_PKG_VER})"
# Make sure the console 'php' (used by cron/schedule:run) is the same version as FPM
update-alternatives --set php "/usr/bin/php${PHPV}" >>"$LOG" 2>&1 || true
[[ $(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;') == "$PHPV" ]] || die "Console php is not ${PHPV}."
PHP_MODS=$(php -m)
for m in mysqli pdo_mysql mbstring xml zip gd curl intl json pcntl fileinfo iconv dom tokenizer openssl; do
  grep -qix "$m" <<<"$PHP_MODS" || die "PHP extension '$m' is missing from console PHP."
done
ok "PHP ${PHPV} with all required extensions"

PHP_RUNNING=$(php -r 'echo PHP_VERSION;')
if $USE_PPA; then
  # The PPA ships upstream point releases, so compare against php.net's latest for this branch
  LATEST=$(curl -fsS --max-time 15 "https://www.php.net/releases/index.php?json&version=${PHPV}" 2>/dev/null \
           | grep -oE '"version" *: *"[0-9]+\.[0-9]+\.[0-9]+"' | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)
  if [[ -z $LATEST ]]; then
    warn "Could not reach php.net to confirm ${PHP_RUNNING} is the latest ${PHPV} release."
  elif dpkg --compare-versions "$PHP_RUNNING" lt "$LATEST"; then
    warn "PHP ${PHP_RUNNING} is older than upstream ${LATEST} - the PPA usually catches up within a day or two;"
    warn "automatic updates will install it (or run: apt-get update && apt-get upgrade)."
  else
    ok "PHP ${PHP_RUNNING} is the latest upstream ${PHPV} release"
  fi
else
  ok "PHP ${PHP_RUNNING} = Ubuntu build ${PHP_PKG_VER} (security fixes are backported into this build)"
fi

# Remove or disable PHP branches that no longer receive security fixes
for b in "${OLD_PHP[@]}"; do
  if $REMOVE_OLD_PHP; then
    mapfile -t _old < <({ dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n' "php${b}*" "libapache2-mod-php${b}" 2>/dev/null || true; } | awk '$1 ~ /^ii|^rc/ {print $2}')
    (( ${#_old[@]} )) && run apt-get purge -y "${_old[@]}"
    ok "Removed unsupported PHP ${b}"
  else
    systemctl disable --now "php${b}-fpm" >>"$LOG" 2>&1 || true
    warn "PHP ${b} left installed (FPM stopped/disabled) - it receives no upstream security fixes"
  fi
done
(( ${#OLD_PHP[@]} )) && $REMOVE_OLD_PHP && run apt-get autoremove -y
update-alternatives --set php "/usr/bin/php${PHPV}" >>"$LOG" 2>&1 || true

PHP_INI_BODY="; Managed by freescout-install.sh
cgi.fix_pathinfo = 0
expose_php = Off
upload_max_filesize = ${MAX_MB}M
post_max_size = $((MAX_MB + 8))M
memory_limit = 512M
max_execution_time = 300
date.timezone = ${APP_TZ}"
echo "$PHP_INI_BODY" >"/etc/php/${PHPV}/fpm/conf.d/99-freescout.ini"
echo "$PHP_INI_BODY" >"/etc/php/${PHPV}/cli/conf.d/99-freescout.ini"
systemctl enable "php${PHPV}-fpm" >>"$LOG" 2>&1
systemctl restart "php${PHPV}-fpm"
ok "php.ini tuned (fpm + cli)"

# =============================================================================
#  2. Database
# =============================================================================
step "Configuring database"
if $DROP_DB; then
  "$SQL_CLI" -e "DROP DATABASE IF EXISTS \`${DB_NAME}\`;" >>"$LOG" 2>&1
  ok "Old '${DB_NAME}' database dropped"
fi
# Syntax below works on MariaDB 10.6+ and MySQL 8.x alike
"$SQL_CLI" <<SQL >>"$LOG" 2>&1
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL
MYSQL_PWD="$DB_PASS" "$SQL_CLI" -u"$DB_USER" -e "SELECT 1" "$DB_NAME" >/dev/null || die "Cannot log in as ${DB_USER}."
ok "Database '${DB_NAME}' and user '${DB_USER}' ready"

# =============================================================================
#  3. Application files
# =============================================================================
step "Downloading FreeScout into ${INSTALL_DIR}"
$WIPE_DIR && rm -rf --one-file-system "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
run git clone "$REPO_URL" "$INSTALL_DIR" || die "git clone failed - check internet access to github.com"
[[ -f $INSTALL_DIR/artisan ]] || die "Clone finished but artisan is missing."
git config --system --add safe.directory "$INSTALL_DIR" >>"$LOG" 2>&1 || true
chown -R www-data:www-data "$INSTALL_DIR"
find "$INSTALL_DIR" -type f -exec chmod 664 {} +
find "$INSTALL_DIR" -type d -exec chmod 775 {} +
chmod 775 "$INSTALL_DIR/tools/"*.sh 2>/dev/null || true
ok "FreeScout $(cd "$INSTALL_DIR" && git describe --tags --always 2>/dev/null) checked out (dist branch)"

# =============================================================================
#  4. TLS certificate
# =============================================================================
SSL_CERT=""; SSL_KEY=""
mkdir -p "$SSL_DIR"; chmod 755 "$SSL_DIR"
case $TLS_MODE in
1)
  step "Creating local CA and server certificate"
  CA_KEY=$SSL_DIR/freescout-ca.key; CA_CRT=$SSL_DIR/freescout-ca.crt
  if [[ -f $CA_KEY && -f $CA_CRT ]]; then
    ok "Re-using existing local CA ($CA_CRT) - clients that trust it keep working"
  else
    (umask 077; openssl genrsa -out "$CA_KEY" 4096 >>"$LOG" 2>&1)
    openssl req -x509 -new -key "$CA_KEY" -sha256 -days 3650 -out "$CA_CRT" \
      -subj "$(C=$CERT_C ST=$CERT_ST L=$CERT_L O=$CERT_O OU=$CERT_OU subject_dn)/CN=${CERT_O:+$CERT_O }FreeScout Local CA" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -addext "subjectKeyIdentifier=hash" >>"$LOG" 2>&1
    ok "CA created (valid 10 years)"
  fi
  # Build SAN list
  SAN_LIST=(); add_san() { local n=$1; [[ -z $n ]] && return; is_ip "$n" && SAN_LIST+=("IP:$n") || SAN_LIST+=("DNS:$n"); }
  add_san "$DOMAIN"
  # short name (https://helpdesk/) and every IPv4 of this server, so any way users reach it is covered
  if ! is_ip "$DOMAIN" && [[ $DOMAIN == *.* ]]; then add_san "${DOMAIN%%.*}"; fi
  add_san "$SERVER_IP"
  for _ip in $(hostname -I 2>/dev/null); do is_ip "$_ip" && add_san "$_ip"; done
  IFS=',' read -ra _extra <<<"$EXTRA_SANS"
  for n in "${_extra[@]}"; do n=$(echo "$n" | xargs); add_san "${n,,}"; done
  SAN=$(printf '%s\n' "${SAN_LIST[@]}" | awk '!seen[$0]++' | paste -sd, -)
  SSL_KEY=$SSL_DIR/${DOMAIN}.key; SSL_CERT=$SSL_DIR/${DOMAIN}.crt
  (umask 077; openssl genrsa -out "$SSL_KEY" 2048 >>"$LOG" 2>&1)
  openssl req -new -key "$SSL_KEY" -subj "$(C=$CERT_C ST=$CERT_ST L=$CERT_L O=$CERT_O OU=$CERT_OU subject_dn)/CN=${DOMAIN}" -out "$SSL_DIR/${DOMAIN}.csr" >>"$LOG" 2>&1
  cat >"$SSL_DIR/${DOMAIN}.ext" <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=${SAN}
authorityKeyIdentifier=keyid,issuer
subjectKeyIdentifier=hash
EXT
  openssl x509 -req -in "$SSL_DIR/${DOMAIN}.csr" -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial \
    -out "$SSL_DIR/${DOMAIN}.leaf.crt" -days "$CERT_DAYS" -sha256 -extfile "$SSL_DIR/${DOMAIN}.ext" >>"$LOG" 2>&1
  cat "$SSL_DIR/${DOMAIN}.leaf.crt" "$CA_CRT" >"$SSL_CERT"
  openssl verify -CAfile "$CA_CRT" "$SSL_DIR/${DOMAIN}.leaf.crt" >>"$LOG" 2>&1 || die "Generated certificate failed verification."
  chmod 644 "$SSL_CERT" "$CA_CRT"; chmod 600 "$SSL_KEY" "$CA_KEY"
  # Trust our own CA on this server too (so any self-calls over HTTPS verify)
  cp "$CA_CRT" /usr/local/share/ca-certificates/freescout-local-ca.crt
  run update-ca-certificates
  ok "Server cert for: ${SAN}  (valid ${CERT_DAYS} days)"
  ;;
2)
  step "Installing your certificate"
  SSL_CERT=$SSL_DIR/${DOMAIN}.crt; SSL_KEY=$SSL_DIR/${DOMAIN}.key
  install -m 644 "$OWN_CERT" "$SSL_CERT"; install -m 600 "$OWN_KEY" "$SSL_KEY"
  if ! openssl x509 -in "$SSL_CERT" -noout -checkhost "$DOMAIN" 2>/dev/null | grep -q "does match"; then
    is_ip "$DOMAIN" && openssl x509 -in "$SSL_CERT" -noout -checkip "$DOMAIN" 2>/dev/null | grep -q "does match" \
      || warn "Certificate does not list ${DOMAIN} in its SANs - browsers will reject it."
  fi
  ok "Certificate installed to $SSL_DIR"
  ;;
3)
  step "Preparing Let's Encrypt"
  run apt-get install -y certbot
  mkdir -p "$ACME_ROOT"
  ;;
esac

# =============================================================================
#  5. Nginx
# =============================================================================
step "Configuring Nginx"
PHP_SOCK=/run/php/php${PHPV}-fpm.sock
SNIPPET=/etc/nginx/snippets/freescout-app.conf
# App block from the official FreeScout wiki (incl. uploads security rules)
cat >"$SNIPPET" <<'NGINX'
# Managed by freescout-install.sh - FreeScout application block
root __ROOT__/public;
index index.php index.html index.htm;
error_log __ROOT__/storage/logs/web-server.log;

# Max attachment size (keep in sync with upload_max_filesize / post_max_size)
client_max_body_size __MAXBODY__M;

location / {
    try_files $uri $uri/ /index.php?$query_string;
}
location ~ \.php$ {
    fastcgi_split_path_info ^(.+\.php)(/.+)$;
    fastcgi_pass unix:__PHPSOCK__;
    fastcgi_index index.php;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    include fastcgi_params;
    fastcgi_read_timeout 300;
}
location ~* ^/storage/attachment/ {
    expires 1M;
    access_log off;
    try_files $uri $uri/ /index.php?$query_string;
}
location ~* ^/(?:css|js)/.*\.(?:css|js)$ {
    expires 2d;
    access_log off;
    add_header Cache-Control "public, must-revalidate";
    add_header X-Content-Type-Options "nosniff";
}
# Force /storage/* files to be downloaded instead of rendered in the browser
location ~* ^/storage/.*\.((?!(jpg|jpeg|jfif|pjpeg|pjp|apng|bmp|gif|ico|cur|png|tif|tiff|webp|pdf|txt|diff|patch|json|mp3|wav|ogg|wma)).)*$ {
    add_header Content-disposition "attachment; filename=$2";
    add_header X-Content-Type-Options "nosniff";
    default_type application/octet-stream;
}
location ~* ^/(storage/|.*\.).*$ {
    expires 1M;
    access_log off;
    add_header Cache-Control "public";
    add_header X-Content-Type-Options "nosniff";
}
location ~ /\. {
    deny all;
}
NGINX
sed -i -e "s|__ROOT__|${INSTALL_DIR}|g" -e "s|__PHPSOCK__|${PHP_SOCK}|g" -e "s|__MAXBODY__|${MAX_MB}|g" "$SNIPPET"

SITE=/etc/nginx/sites-available/freescout.conf
HAS_V6=false; [[ -f /proc/net/if_inet6 ]] && HAS_V6=true   # don't bind [::] on IPv6-disabled hosts
write_http_only() {   # $1 = include app (true) or just redirect/acme (false)
  {
    echo "# Managed by freescout-install.sh"
    echo "server {"
    echo "    listen 80 default_server;"
    $HAS_V6 && echo "    listen [::]:80 default_server;"
    echo "    server_name ${DOMAIN};"
    echo "    location ^~ /.well-known/acme-challenge/ { root ${ACME_ROOT}; default_type text/plain; }"
    if [[ $TLS_MODE == 1 ]]; then
      echo "    # Download the local CA for client import:  http://${DOMAIN}/freescout-ca.crt"
      echo "    location = /freescout-ca.crt { alias ${SSL_DIR}/freescout-ca.crt; default_type application/x-x509-ca-cert; }"
    fi
    if [[ $1 == true ]]; then echo "    include ${SNIPPET};"
    else echo "    location / { return 301 https://\$host\$request_uri; }"; fi
    echo "}"
  } >"$SITE"
}
write_https() {
  write_http_only false
  local v6=""; $HAS_V6 && v6="    listen [::]:443 ssl default_server;"
  cat >>"$SITE" <<EOF

server {
    listen 443 ssl default_server;
${v6}
    server_name ${DOMAIN};

    ssl_certificate     ${SSL_CERT};
    ssl_certificate_key ${SSL_KEY};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:FreeScoutSSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    include ${SNIPPET};
}
EOF
}

mkdir -p "$ACME_ROOT"
rm -f /etc/nginx/sites-enabled/default
ln -sf "$SITE" /etc/nginx/sites-enabled/freescout.conf

if [[ $TLS_MODE == 3 ]]; then
  write_http_only true
  nginx -t >>"$LOG" 2>&1 || { nginx -t; die "Nginx config test failed."; }
  systemctl restart nginx
  step "Requesting Let's Encrypt certificate for ${DOMAIN}"
  if certbot certonly --webroot -w "$ACME_ROOT" -d "$DOMAIN" --non-interactive --agree-tos \
       -m "$LE_EMAIL" --deploy-hook "systemctl reload nginx" >>"$LOG" 2>&1; then
    SSL_CERT=/etc/letsencrypt/live/${DOMAIN}/fullchain.pem
    SSL_KEY=/etc/letsencrypt/live/${DOMAIN}/privkey.pem
    write_https
    ok "Certificate issued; renewal handled by certbot.timer"
  else
    warn "Let's Encrypt failed (see $LOG). Continuing with HTTP only - re-run later or use option 1/2."
    TLS_MODE=4; PROTO=http
  fi
elif [[ $TLS_MODE == 4 ]]; then
  write_http_only true
else
  write_https
fi
nginx -t >>"$LOG" 2>&1 || { nginx -t; die "Nginx config test failed."; }
systemctl restart nginx >>"$LOG" 2>&1 || true
sleep 1
pgrep -x nginx >/dev/null || die "Nginx failed to start - run: journalctl -u nginx -n 50"
ok "Nginx running - site: $SITE"

# Make the name resolve on the server itself
if ! is_ip "$DOMAIN" && ! getent hosts "$DOMAIN" >/dev/null; then
  echo "${SERVER_IP} ${DOMAIN}  # freescout" >>/etc/hosts
  ok "Added ${DOMAIN} -> ${SERVER_IP} to /etc/hosts on this server"
fi

# =============================================================================
#  6. FreeScout setup
# =============================================================================
artisan() { (cd "$INSTALL_DIR" && runuser -u www-data -- env HOME=/var/www php artisan "$@"); }
if [[ $SETUP_MODE == 1 ]]; then
  step "Setting up FreeScout from the command line"
  rm -f "$INSTALL_DIR/.env" "$INSTALL_DIR/storage/.installed"
  {
    echo "APP_URL=${PROTO}://${DOMAIN}"
    echo "APP_TIMEZONE=${APP_TZ}"
    [[ $PROTO == https ]] && echo "SESSION_SECURE_COOKIE=true"
    [[ -n $WHITELIST ]] && echo "APP_REMOTE_HOST_WHITE_LIST=\"${WHITELIST// /}\""
    echo "DB_CONNECTION=mysql"
    echo "DB_HOST=localhost"
    echo "DB_PORT=3306"
    echo "DB_DATABASE=${DB_NAME}"
    echo "DB_USERNAME=${DB_USER}"
    echo "DB_PASSWORD=${DB_PASS}"
    echo "APP_KEY="
  } >"$INSTALL_DIR/.env"
  chown www-data:www-data "$INSTALL_DIR/.env"; chmod 640 "$INSTALL_DIR/.env"

  artisan key:generate --force >>"$LOG" 2>&1 || die "key:generate failed"
  grep -q '^APP_KEY=base64:' "$INSTALL_DIR/.env" || die "APP_KEY was not written to .env"
  artisan freescout:clear-cache >>"$LOG" 2>&1 || true
  [[ -L $INSTALL_DIR/public/storage ]] || artisan storage:link >>"$LOG" 2>&1 || true
  artisan migrate --force >>"$LOG" 2>&1 || die "Database migration failed - see $LOG"
  ok "Database tables created"
  # create-user exits 0 even on failure, so check its output instead
  CU_OUT=$(artisan freescout:create-user --role=admin --firstName="$ADMIN_FIRST" --lastName="$ADMIN_LAST" \
       --email="$ADMIN_EMAIL" --password="$ADMIN_PASS" --no-interaction 2>&1 || true)
  { grep -v -i password <<<"$CU_OUT" || true; } >>"$LOG"
  if grep -q "User created with id" <<<"$CU_OUT"; then
    ok "Admin user ${ADMIN_EMAIL} created"
  else
    warn "Could not create admin (it may already exist). Create one with: cd $INSTALL_DIR && sudo -u www-data php artisan freescout:create-user"
  fi
  runuser -u www-data -- touch "$INSTALL_DIR/storage/.installed"
  artisan freescout:clear-cache >>"$LOG" 2>&1 || true
  unset ADMIN_PASS
fi

step "Checking FreeScout requirements"
artisan freescout:check-requirements 2>&1 | tee -a "$LOG" | sed 's/^/    /' || true
chown -R www-data:www-data "$INSTALL_DIR"

# =============================================================================
#  7. Cron (as www-data - never root, or cache files break)
# =============================================================================
step "Installing cron jobs"
{
  echo "# Managed by freescout-install.sh"
  echo "SHELL=/bin/bash"
  echo "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  echo "* * * * * www-data /usr/bin/php ${INSTALL_DIR}/artisan schedule:run >> /dev/null 2>&1"
  if $AUTO_UPDATE; then echo "0 1 * * * www-data ${INSTALL_DIR}/tools/update.sh --yes >> ${INSTALL_DIR}/storage/logs/update.log 2>&1"
  else echo "#0 1 * * * www-data ${INSTALL_DIR}/tools/update.sh --yes >> ${INSTALL_DIR}/storage/logs/update.log 2>&1"; fi
} >/etc/cron.d/freescout
chmod 644 /etc/cron.d/freescout
# remove an old www-data crontab schedule line from the upstream installer, if any
if crontab -u www-data -l 2>/dev/null | grep -q 'artisan schedule:run'; then
  crontab -u www-data -l | grep -v 'artisan schedule:run' | crontab -u www-data - || true
  warn "Removed duplicate schedule:run from www-data's personal crontab"
fi
ok "/etc/cron.d/freescout"

# =============================================================================
#  7b. Automatic security updates (keeps PHP patched after install)
# =============================================================================
if $AUTO_SEC; then
  step "Enabling automatic security updates"
  run apt-get install -y unattended-upgrades
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF2'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF2
  if $USE_PPA; then
    # Ubuntu's -security pocket is allowed by default; also allow the PHP PPA
    cat >/etc/apt/apt.conf.d/51freescout-php-ppa <<'EOF2'
// Managed by freescout-install.sh - let unattended-upgrades patch PHP from ppa:ondrej/php
Unattended-Upgrade::Allowed-Origins:: "LP-PPA-ondrej-php:${distro_codename}";
EOF2
  fi
  systemctl enable --now unattended-upgrades apt-daily.timer apt-daily-upgrade.timer >>"$LOG" 2>&1 || true
  if unattended-upgrade --dry-run >>"$LOG" 2>&1; then ok "unattended-upgrades enabled (daily)$($USE_PPA && echo ", incl. ppa:ondrej/php")"
  else warn "unattended-upgrades dry-run reported a problem - see $LOG"; fi
else
  warn "Automatic updates disabled - patch PHP yourself: apt-get update && apt-get upgrade"
fi

# =============================================================================
#  8. Firewall + mDNS
# =============================================================================
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  step "Opening firewall (ufw)"
  run ufw allow 80/tcp; [[ $PROTO == https ]] && run ufw allow 443/tcp
  ok "ufw: 80$([[ $PROTO == https ]] && echo ", 443") allowed"
fi

if $MDNS; then
  step "Publishing ${DOMAIN} via mDNS (Avahi)"
  run apt-get install -y avahi-daemon avahi-utils
  systemctl enable --now avahi-daemon >>"$LOG" 2>&1
  if [[ $DOMAIN == "$(hostname -s).local" ]]; then
    ok "Hostname already matches - Avahi announces ${DOMAIN} automatically"
  else
    cat >/etc/systemd/system/freescout-mdns.service <<EOF
[Unit]
Description=Announce ${DOMAIN} via mDNS for FreeScout
After=avahi-daemon.service network-online.target
Requires=avahi-daemon.service

[Service]
ExecStart=/usr/bin/avahi-publish -a -R ${DOMAIN} ${SERVER_IP}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now freescout-mdns.service >>"$LOG" 2>&1
    ok "freescout-mdns.service announcing ${DOMAIN} -> ${SERVER_IP}"
  fi
fi

# =============================================================================
#  9. Smoke test
# =============================================================================
step "Testing the site"
if [[ $PROTO == https ]]; then
  CURL_CA=(); [[ $TLS_MODE == 1 ]] && CURL_CA=(--cacert "$SSL_DIR/freescout-ca.crt")
  CODE=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "${CURL_CA[@]}" --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/login" || true)
else
  CODE=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --resolve "${DOMAIN}:80:127.0.0.1" "http://${DOMAIN}/login" || true)
fi
case $CODE in
  200|302) ok "${PROTO}://${DOMAIN}/login returned ${CODE}";;
  *) warn "${PROTO}://${DOMAIN}/login returned ${CODE} - check ${INSTALL_DIR}/storage/logs and $LOG";;
esac

# =============================================================================
#  Summary
# =============================================================================
INFO=/root/freescout-install-info.txt
{
  echo "FreeScout installed $(date)"
  echo "URL:            ${PROTO}://${DOMAIN}"
  echo "Install dir:    ${INSTALL_DIR}"
  echo "PHP:            ${PHP_RUNNING} - package ${PHP_PKG_VER} from $($USE_PPA && echo "ppa:ondrej/php" || echo "Ubuntu ${VERSION_CODENAME}-security")"
  echo "PHP support:    upstream security fixes until ${PHP_EOL[$PHPV]} - plan an upgrade before then"
  echo "Auto-patching:  $($AUTO_SEC && echo "unattended-upgrades enabled" || echo "OFF")"
  echo "DB name/user:   ${DB_NAME} / ${DB_USER}"
  echo "DB password:    ${DB_PASS}"
  [[ $SETUP_MODE == 1 ]] && echo "Admin login:    ${ADMIN_EMAIL}"
  [[ -n $SSL_CERT ]] && echo "TLS cert/key:   ${SSL_CERT} / ${SSL_KEY}"
  [[ $TLS_MODE == 1 ]] && echo "Local CA:       ${SSL_DIR}/freescout-ca.crt  (download: http://${DOMAIN}/freescout-ca.crt)"
  echo "Nginx site:     ${SITE}  (+ ${SNIPPET})"
  echo "Cron:           /etc/cron.d/freescout"
} >"$INFO"; chmod 600 "$INFO"

echo -e "\n${c_green}############################################################"
echo -e "##   FreeScout installation complete                      ##"
echo -e "############################################################${c_off}"
cat "$INFO" | sed '1d; s/^/  /'
echo
if [[ $SETUP_MODE == 2 ]]; then
  echo "  Next: open ${PROTO}://${DOMAIN}/install and use the DB details above."
  echo "        Skip the installer's cron step - it is already configured."
else
  echo "  Next: open ${PROTO}://${DOMAIN} and sign in as ${ADMIN_EMAIL}."
fi
if [[ $TLS_MODE == 1 ]]; then
  cat <<EOF

  Trusting the self-signed cert on client machines:
    - Download http://${DOMAIN}/freescout-ca.crt
    - Windows: import into "Trusted Root Certification Authorities"
        (for a domain: GPO > Computer Config > Policies > Windows Settings >
         Security Settings > Public Key Policies > Trusted Root CAs)
    - macOS: open in Keychain Access > System > set "Always Trust"
    - Firefox uses its own store unless security.enterprise_roots.enabled=true
EOF
fi
if [[ $DOMAIN == *.local ]] && ! $MDNS; then
  echo -e "\n  DNS: add an A record ${DOMAIN} -> ${SERVER_IP} in your internal DNS."
fi
echo -e "\n  Details saved to ${INFO} (root only). Full log: ${LOG}\n"
