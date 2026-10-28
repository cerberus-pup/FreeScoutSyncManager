#!/usr/bin/env bash
# =============================================================================
#  cert-tool.sh - check and fix HTTPS certificates for Chrome / Edge / Safari
#  Works on servers set up by freescout-install.sh or the FreeScout Sync
#  Manager installer (local CA in /etc/ssl/freescout or /etc/ssl/fsmanager),
#  and checks any other nginx site too (e.g. a certificate from your AD CS).
#
#  sudo bash cert-tool.sh check               # explain what browsers will reject
#  sudo bash cert-tool.sh reissue             # new server cert from the local CA (CA kept,
#                                             #   so PCs that already trust it keep working)
#  sudo bash cert-tool.sh reissue --new-ca    # also replace the CA (PCs must import the new CA)
#  sudo bash cert-tool.sh renew-if-needed     # for cron: reissue silently if < 45 days left
# =============================================================================
set -Eeuo pipefail

c_g='\033[1;32m'; c_y='\033[1;33m'; c_r='\033[1;31m'; c_b='\033[1;34m'; c_0='\033[0m'
pass() { echo -e "   ${c_g}PASS${c_0} $*"; }
warn() { echo -e "   ${c_y}WARN${c_0} $*"; WARNS=$((WARNS+1)); }
fail() { echo -e "   ${c_r}FAIL${c_0} $*"; FAILS=$((FAILS+1)); }
info() { echo -e "   ${c_b}INFO${c_0} $*"; }
die()  { echo -e "${c_r}[FATAL]${c_0} $*" >&2; exit 1; }
FAILS=0; WARNS=0
LEAF_DAYS=820      # Apple platforms reject > 825 days; Chrome/Edge have no limit for private CAs
[[ $EUID -eq 0 ]] || die "Run as root: sudo bash $0 ${1:-check}"
command -v openssl >/dev/null || die "openssl not found"

if [[ -t 0 ]]; then TTY=/dev/stdin; elif { : </dev/tty; } 2>/dev/null; then TTY=/dev/tty; else TTY=""; fi   # no terminal (cron): use defaults
ask() { local p=$1 d=${2-} r; [[ -z $TTY ]] && { printf '%s' "$d"; return; }
  if [[ -n $d ]]; then read -r -p "  $p [$d]: " r <"$TTY"; else read -r -p "  $p: " r <"$TTY"; fi
  r="${r#"${r%%[![:space:]]*}"}"; r="${r%"${r##*[![:space:]]}"}"; printf '%s' "${r:-$d}"; }
is_ip() { [[ $1 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }

# ── discover nginx sites: "site|server_names|cert|key" ─────────────────────────
sites() {
  local f names cert key
  for f in /etc/nginx/sites-enabled/*; do
    [[ -f $f ]] || continue
    cert=$(grep -hoP '(?<![\w])ssl_certificate\s+\K[^;]+' "$f" | head -1 || true)
    [[ -n $cert ]] || continue
    key=$(grep -hoP '(?<![\w])ssl_certificate_key\s+\K[^;]+' "$f" | head -1 || true)
    names=$(grep -hoP '(?<![\w])server_name\s+\K[^;]+' "$f" | tr ' ' '\n' | grep -vE '^(_|)$' | sort -u | tr '\n' ' ')
    echo "$(basename "$f")|${names% }|$cert|$key"
  done
}

leaf_of() { openssl x509 -in "$1" 2>/dev/null; }     # first cert in a (chain) file
sans_of() { openssl x509 -in "$1" -noout -ext subjectAltName 2>/dev/null | tail -n +2 | tr ',' '\n' | sed 's/^ *//' | grep -E '^(DNS|IP Address):' || true; }
covers() {   # covers <certfile> <name>
  local n=$1 c=$2 s
  while IFS= read -r s; do
    case $s in
      "DNS:$c") return 0 ;;
      "IP Address:$c") return 0 ;;
      DNS:\*.*) [[ $c == *.* && ${c#*.} == "${s#DNS:\*.}" ]] && return 0 ;;
    esac
  done < <(sans_of "$n")
  return 1
}
find_ca_dir() {   # local CA created by our installers
  local d
  for d in /etc/ssl/freescout /etc/ssl/fsmanager; do
    compgen -G "$d/*-ca.key" >/dev/null && { echo "$d"; return 0; }
  done
  return 1
}

check_site() {
  local site=$1 names=$2 cert=$3 key=$4
  echo -e "\n${c_b}== $site${c_0}  ($cert)"
  [[ -r $cert ]] || { fail "certificate file not readable"; return; }
  local tmp; tmp=$(mktemp); leaf_of "$cert" >"$tmp"
  [[ -s $tmp ]] || { fail "not a PEM certificate"; rm -f "$tmp"; return; }
  local subj issuer; subj=$(openssl x509 -in "$tmp" -noout -subject | sed 's/^subject=//'); issuer=$(openssl x509 -in "$tmp" -noout -issuer | sed 's/^issuer=//')
  info "subject: $subj"
  info "issuer:  $issuer"

  # 1. Subject Alternative Name (Chrome 58+ and Edge ignore the CN entirely)
  if [[ -z $(sans_of "$tmp") ]]; then
    fail "no Subject Alternative Name - Chrome/Edge reject it with ERR_CERT_COMMON_NAME_INVALID (the CN is ignored). Re-issue it with SANs (AD CS: add DNS= entries in the request's SAN attribute)."
  else
    pass "SAN: $(sans_of "$tmp" | tr '\n' ' ')"
    local n missing=()
    for n in $names; do covers "$tmp" "$n" || missing+=("$n"); done
    if (( ${#missing[@]} )); then fail "names nginx answers to but the cert doesn't list: ${missing[*]} - browsing to these gives ERR_CERT_COMMON_NAME_INVALID"
    else pass "covers every server_name ($names)"; fi
    local h ip; h=$(hostname -s 2>/dev/null || true)
    for ip in $(hostname -I 2>/dev/null); do is_ip "$ip" && ! covers "$tmp" "$ip" && info "server IP $ip is not in the cert - https://$ip will show a warning (fine if nobody uses the IP)"; done
    [[ -n $h ]] && ! covers "$tmp" "$h" && info "short name '$h' is not in the cert - https://$h/ will show a warning (fine if users type the full name)"
  fi
  # 2. purpose
  local eku ku bc; eku=$(openssl x509 -in "$tmp" -noout -ext extendedKeyUsage 2>/dev/null | tail -n +2 || true)
  ku=$(openssl x509 -in "$tmp" -noout -ext keyUsage 2>/dev/null | tail -n +2 || true)
  bc=$(openssl x509 -in "$tmp" -noout -ext basicConstraints 2>/dev/null | tail -n +2 || true)
  if [[ -z $eku ]]; then warn "no Extended Key Usage - allowed, but add 'TLS Web Server Authentication' (serverAuth)"
  elif grep -q 'TLS Web Server Authentication' <<<"$eku"; then pass "EKU includes serverAuth"
  else fail "EKU lacks serverAuth ($eku) - browsers reject it (ERR_CERT_INVALID)"; fi
  if [[ -n $ku ]] && ! grep -q 'Digital Signature' <<<"$ku"; then fail "Key Usage lacks digitalSignature ($ku) - Chrome/Edge fail with ERR_SSL_KEY_USAGE_INCOMPATIBLE"
  else pass "Key Usage OK${ku:+ ($(echo $ku))}"; fi
  grep -q 'CA:TRUE' <<<"$bc" && fail "server cert is marked as a CA (basicConstraints CA:TRUE)"
  # 3. crypto + dates
  local sig bits; sig=$(openssl x509 -in "$tmp" -noout -text | grep -m1 'Signature Algorithm' | awk -F': ' '{print $2}')
  bits=$(openssl x509 -in "$tmp" -noout -text | grep -m1 -oE '\(([0-9]+) bit\)' | grep -oE '[0-9]+' || echo 0)
  [[ $sig =~ sha1|md5 ]] && fail "weak signature $sig" || pass "signature $sig, ${bits}-bit key"
  [[ $sig == *rsa* && $bits -lt 2048 ]] && fail "RSA key smaller than 2048 bits"
  local nb na now days; nb=$(date -d "$(openssl x509 -in "$tmp" -noout -startdate | cut -d= -f2)" +%s); na=$(date -d "$(openssl x509 -in "$tmp" -noout -enddate | cut -d= -f2)" +%s); now=$(date +%s)
  days=$(( (na - nb) / 86400 ))
  if (( now < nb )); then fail "not valid yet (starts $(date -d @"$nb")) - check the server/PC clocks"
  elif (( now > na )); then fail "EXPIRED on $(date -d @"$na")"
  else pass "valid until $(date -d @"$na" +%F) ($(( (na - now) / 86400 )) days left)"; fi
  (( days > 825 )) && warn "lifetime is $days days - Safari/macOS/iOS reject private certs over 825 days (Chrome/Edge on Windows accept it)"
  # 4. chain
  if [[ $subj == "$issuer" ]]; then
    fail "self-signed server certificate (no CA) - every PC must trust this exact cert, and it breaks when re-generated. Use the local CA: sudo bash $0 reissue"
  else
    local cad bundle; bundle=$(mktemp)
    cad=$(find_ca_dir || true)
    cat "$cert" >"$bundle"; [[ -n $cad ]] && cat "$cad"/*-ca.crt >>"$bundle" 2>/dev/null || true
    if openssl verify -CAfile "$bundle" -untrusted "$cert" "$tmp" >/dev/null 2>&1; then pass "chain verifies up to the issuing CA ($issuer)"
    elif openssl verify -untrusted "$cert" "$tmp" >/dev/null 2>&1; then pass "chain verifies to a publicly trusted root"
    else warn "can't verify the chain here (CA not on this server). PCs need the issuing CA in 'Trusted Root Certification Authorities' (AD CS roots usually arrive via Group Policy)"; fi
    rm -f "$bundle"
  fi
  # 5. key matches + what nginx actually serves
  if [[ -r $key ]]; then
    [[ $(openssl x509 -in "$tmp" -noout -pubkey | openssl sha256) == $(openssl pkey -in "$key" -pubout 2>/dev/null | openssl sha256) ]] && pass "private key matches" || fail "private key does not match the certificate"
  fi
  local n1 served; n1=${names%% *}
  if [[ -n $n1 ]]; then
    served=$(echo | timeout 10 openssl s_client -connect 127.0.0.1:443 -servername "$n1" 2>/dev/null | openssl x509 -noout -fingerprint -sha256 2>/dev/null || true)
    if [[ -z $served ]]; then warn "could not fetch the cert nginx serves for $n1 (nginx stopped?)"
    elif [[ $served == "$(openssl x509 -in "$tmp" -noout -fingerprint -sha256)" ]]; then pass "nginx is serving this certificate for $n1"
    else fail "nginx serves a DIFFERENT certificate for $n1 - reload nginx: systemctl reload nginx"; fi
  fi
  rm -f "$tmp"
}

cmd_check() {
  local any=0 line
  while IFS='|' read -r site names cert key; do any=1; check_site "$site" "$names" "$cert" "$key"; done < <(sites)
  (( any )) || die "no HTTPS sites found in /etc/nginx/sites-enabled"
  echo
  if (( FAILS )); then echo -e "${c_r}$FAILS problem(s) will make Chrome/Edge show a warning.${c_0}"
    find_ca_dir >/dev/null && echo "  Fix: sudo bash $0 reissue"
  else echo -e "${c_g}The server side is correct.${c_0}"; fi
  local cad; cad=$(find_ca_dir || true)
  cat <<EOF

If a PC still shows a warning, check the error code on the warning page:
  ERR_CERT_AUTHORITY_INVALID   the CA isn't trusted on that PC. Import $( [[ -n $cad ]] && echo "$(ls "$cad"/*-ca.crt | head -1)" || echo "your CA certificate") into
                               "Trusted Root Certification Authorities" (choose the store yourself - the
                               wizard's automatic choice can put it under Intermediate CAs). Restart the browser.
  ERR_CERT_COMMON_NAME_INVALID the address typed isn't one of the cert's names - use a listed name, or reissue with it.
  ERR_CERT_DATE_INVALID        the server's or the PC's clock is wrong, or the cert expired.
EOF
}

# Build "/C=../ST=../L=../O=../OU=.." leaving out blank fields ("/" in a value would split the subject)
subject_dn() { local out="" k v; for k in C ST L O OU; do v=${!k-}; v=${v//\//-}; [[ -n $v ]] && out+="/$k=$v"; done; printf '%s' "$out"; }
subject_of_existing() { openssl x509 -in "$1" -noout -subject -nameopt sep_multiline 2>/dev/null | sed -n "s/^ *$2=//p" | head -1; }

cmd_reissue() {
  local new_ca=false quiet=false
  for a in "$@"; do case $a in --new-ca) new_ca=true;; --quiet) quiet=true;; esac; done
  local cad; cad=$(find_ca_dir) || die "No local CA found in /etc/ssl/freescout or /etc/ssl/fsmanager. For an AD CS certificate, request a new one with SAN entries from your CA instead."
  local cakey cacrt; cakey=$(ls "$cad"/*-ca.key | head -1); cacrt=${cakey%.key}.crt
  local site names cert key line
  line=$(sites | while IFS='|' read -r s n c k; do [[ $c == "$cad"/* ]] && { echo "$s|$n|$c|$k"; break; }; done || true)
  [[ -n $line ]] || die "No nginx site uses a certificate from $cad"
  IFS='|' read -r site names cert key <<<"$line"
  [[ -n $key ]] || die "ssl_certificate_key not found for $site"

  # names: everything nginx answers to + current SANs + short names + this server's IPs
  local all=() s
  # every site that uses this same certificate file contributes its names
  names=$(sites | while IFS='|' read -r _s n c _k; do [[ $c == "$cert" ]] && echo "$n"; done | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ' || true)
  # keep the current primary name (CN) first so it stays the certificate's main name
  local cur_cn; cur_cn=$(subject_of_existing "$cert" CN)
  [[ -n $cur_cn ]] && all+=("$cur_cn")
  for s in $names; do all+=("$s"); done
  while IFS= read -r s; do all+=("${s#*:}"); done < <(sans_of "$cert")
  for s in $names; do [[ $s == *.* ]] && ! is_ip "$s" && all+=("${s%%.*}"); done
  for s in $(hostname -I 2>/dev/null); do is_ip "$s" && all+=("$s"); done
  local uniq; uniq=$(printf '%s\n' "${all[@]}" | sed 's/^ *//; s/ *$//' | grep -v '^$' | awk '!seen[tolower($0)]++' | paste -sd, -)

  local O OU L ST C
  O=$(subject_of_existing "$cert" O); OU=$(subject_of_existing "$cert" OU); L=$(subject_of_existing "$cert" L); ST=$(subject_of_existing "$cert" ST); C=$(subject_of_existing "$cert" C)
  [[ -z $O || $O == FreeScout ]] && O=${CERT_O-}; [[ -z $OU ]] && OU=${CERT_OU-}
  [[ -z $L ]] && L=${CERT_L-}; [[ -z $ST ]] && ST=${CERT_ST-}; [[ -z $C ]] && C=${CERT_C:-US}
  if ! $quiet; then
    echo -e "${c_b}Reissue the certificate for $site${c_0} (CA: $cacrt)"
    uniq=$(ask "Names and IPs (comma-separated)" "$uniq")
    echo "  Certificate details (blank = leave out):"
    O=$(ask "Organization (O)" "$O"); OU=$(ask "Department (OU)" "$OU"); L=$(ask "City (L)" "$L"); ST=$(ask "State (ST)" "$ST"); C=$(ask "Country code (C)" "$C")
    [[ $C =~ ^[A-Za-z]{2}$ ]] || die "Country must be a 2-letter code"
  fi
  local cn san=() n; cn=${uniq%%,*}
  IFS=',' read -ra arr <<<"$uniq"
  for n in "${arr[@]}"; do n=$(echo "$n" | xargs); [[ -z $n ]] && continue; is_ip "$n" && san+=("IP:$n") || san+=("DNS:${n,,}"); done
  local SAN; SAN=$(printf '%s\n' "${san[@]}" | awk '!seen[$0]++' | paste -sd, -)
  local esc_subj; esc_subj=$(C=${C^^} ST=$ST L=$L O=$O OU=$OU subject_dn)

  local work; work=$(mktemp -d); trap 'rm -rf "$work"' RETURN
  if $new_ca; then
    $quiet || echo "  Creating a NEW CA - every PC must import it again."
    cp -a "$cakey" "$cakey.old.$(date +%s)"; cp -a "$cacrt" "$cacrt.old.$(date +%s)"
    (umask 077; openssl genrsa -out "$cakey" 4096 2>/dev/null)
    openssl req -x509 -new -key "$cakey" -sha256 -days 3650 -out "$cacrt" -subj "$esc_subj/CN=${O:+$O }Local Root CA ($(hostname -s))" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -addext "subjectKeyIdentifier=hash" -addext "authorityKeyIdentifier=keyid:always" 2>/dev/null
    chmod 644 "$cacrt"; chmod 600 "$cakey"
  fi
  (umask 077; openssl genrsa -out "$work/server.key" 2048 2>/dev/null)
  openssl req -new -key "$work/server.key" -subj "$esc_subj/CN=$cn" -out "$work/server.csr" 2>/dev/null
  cat >"$work/server.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$SAN
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF
  openssl x509 -req -in "$work/server.csr" -CA "$cacrt" -CAkey "$cakey" -CAcreateserial -CAserial "$cad/ca.srl" \
    -out "$work/server.leaf.crt" -days "$LEAF_DAYS" -sha256 -extfile "$work/server.ext" 2>/dev/null
  openssl verify -CAfile "$cacrt" "$work/server.leaf.crt" >/dev/null || die "new certificate failed verification"
  # install (keep a backup of the old pair)
  local stamp; stamp=$(date +%Y%m%d-%H%M%S)
  cp -a "$cert" "$cert.bak-$stamp"; cp -a "$key" "$key.bak-$stamp"
  cat "$work/server.leaf.crt" "$cacrt" >"$cert"; chmod 644 "$cert"
  install -m 600 "$work/server.key" "$key"
  cp "$cacrt" /usr/local/share/ca-certificates/"$(basename "$cacrt")" && update-ca-certificates >/dev/null 2>&1 || true
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx >/dev/null 2>&1 || nginx -s reload >/dev/null 2>&1 || true
    sleep 1; pgrep -x nginx >/dev/null || systemctl restart nginx >/dev/null 2>&1 || nginx || true
    pgrep -x nginx >/dev/null || die "nginx is not running - check: journalctl -u nginx -n 30"
  else cp -a "$cert.bak-$stamp" "$cert"; cp -a "$key.bak-$stamp" "$key"; die "nginx rejected the new certificate - old one restored"; fi
  $quiet && { echo "reissued $cert (names: $SAN)"; return; }
  echo -e "  ${c_g}✓${c_0} new certificate installed for: $SAN (valid $LEAF_DAYS days, old one saved as $cert.bak-$stamp)"
  $new_ca && echo -e "  ${c_y}!${c_0} Import the NEW CA on every PC: $cacrt (also downloadable from http://$cn/$(basename "$cacrt") if your site serves it)"
  FAILS=0; WARNS=0; check_site "$site" "$names" "$cert" "$key"
}

cmd_renew_if_needed() {
  local cad line cert left
  cad=$(find_ca_dir) || exit 0
  line=$(sites | while IFS='|' read -r s n c k; do [[ $c == "$cad"/* ]] && { echo "$c"; break; }; done || true)
  [[ -n $line ]] || exit 0
  cert=$line
  left=$(( ( $(date -d "$(openssl x509 -in "$cert" -noout -enddate | cut -d= -f2)" +%s) - $(date +%s) ) / 86400 ))
  (( left < 45 )) && cmd_reissue --quiet || true
}

case ${1:-check} in
  check) cmd_check ;;
  reissue) shift; cmd_reissue "$@" ;;
  renew-if-needed) cmd_renew_if_needed ;;
  install-renewal)   # daily cron job that renews the local-CA cert before it expires
    install -m 755 "$(readlink -f "$0")" /usr/local/sbin/cert-tool
    echo '17 3 * * * root /usr/local/sbin/cert-tool renew-if-needed >> /var/log/cert-tool.log 2>&1' >/etc/cron.d/cert-tool
    echo "Installed /usr/local/sbin/cert-tool and /etc/cron.d/cert-tool (daily renewal check)" ;;
  *) echo "usage: $0 check | reissue [--new-ca] | renew-if-needed | install-renewal"; exit 2 ;;
esac
