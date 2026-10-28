<#
.SYNOPSIS
  Explains (and optionally fixes) "NET::ERR_CERT_AUTHORITY_INVALID" for an internal HTTPS site
  that uses a local CA (FreeScout / FreeScout Sync Manager installers).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\Test-SiteCertificate.ps1 -Url https://helpdesk.example.local
  powershell -ExecutionPolicy Bypass -File .\Test-SiteCertificate.ps1 -Url https://helpdesk.example.local -Fix
  (Run -Fix from an elevated PowerShell to install the CA for all users of the PC.)
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [switch]$Fix
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
$X = [System.Security.Cryptography.X509Certificates.X509Certificate2]

function Write-Res([string]$Kind, [string]$Text) {
  $color = @{ PASS = 'Green'; FAIL = 'Red'; WARN = 'Yellow'; INFO = 'Cyan' }[$Kind]
  Write-Host ('  {0,-4} ' -f $Kind) -ForegroundColor $color -NoNewline; Write-Host $Text
}
function Get-Ski($cert) {
  $e = $cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.14' } | Select-Object -First 1
  if ($e) { return ([System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]$e).SubjectKeyIdentifier.ToUpper() }
  return $null
}
function Get-Aki($cert) {   # keyIdentifier [0] inside the AuthorityKeyIdentifier SEQUENCE
  $e = $cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.35' } | Select-Object -First 1
  if (-not $e) { return $null }
  $r = $e.RawData; $i = 1
  if ($r[$i] -band 0x80) { $i += ($r[$i] -band 0x7F) }   # long-form SEQUENCE length
  $i++
  while ($i -lt $r.Length - 1) {
    $tag = $r[$i]; $len = $r[$i + 1]
    if ($tag -eq 0x80) { return (($r[($i + 2)..($i + 1 + $len)] | ForEach-Object { $_.ToString('X2') }) -join '') }
    $i += 2 + $len
  }
  return $null
}
function Get-San($cert) {
  $e = $cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' } | Select-Object -First 1
  if ($e) { return $e.Format($false) } else { return '(none)' }
}
function Get-StoreCerts {
  foreach ($loc in 'LocalMachine', 'CurrentUser') {
    foreach ($name in 'Root', 'CA', 'My', 'Disallowed') {
      try {
        $s = New-Object System.Security.Cryptography.X509Certificates.X509Store($name, $loc)
        $s.Open('ReadOnly')
        foreach ($c in $s.Certificates) { [pscustomobject]@{ Store = "$loc\$name"; Cert = $c; Ski = (Get-Ski $c) } }
        $s.Close()
      } catch { }
    }
  }
}
function Get-ServedCertificate([string]$HostName, [int]$Port) {
  $script:served = $null
  $cb = [System.Net.Security.RemoteCertificateValidationCallback] { param($s, $c, $ch, $e) $script:served = $c; return $true }
  $tcp = New-Object System.Net.Sockets.TcpClient($HostName, $Port)
  try {
    $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, $cb)
    $ssl.AuthenticateAsClient($HostName, $null, [System.Security.Authentication.SslProtocols]::Tls12, $false)
    return (New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate))
  } finally { $tcp.Close() }
}
function Test-Trust($leaf) {   # Windows' own chain decision (revocation off: local CAs publish no CRL)
  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
  $chain.ChainPolicy.RevocationMode = 'NoCheck'
  $ok = $chain.Build($leaf)
  $status = @($chain.ChainStatus | ForEach-Object { $_.Status.ToString() } | Where-Object { $_ -notin 'RevocationStatusUnknown', 'OfflineRevocation' })
  [pscustomobject]@{ Ok = ($ok -or $status.Count -eq 0); Status = $status; Elements = @($chain.ChainElements | ForEach-Object { $_.Certificate }) }
}

$uri = [Uri]$Url
$port = if ($uri.Port -gt 0) { $uri.Port } else { 443 }
Write-Host "`nChecking $($uri.Host):$port" -ForegroundColor White

# 1. What the server actually sends
try { $leaf = Get-ServedCertificate $uri.Host $port }
catch {
  $msg = if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message }
  Write-Res FAIL "Could not connect: $msg"; exit 2
}
$aki = Get-Aki $leaf
Write-Res INFO "Server certificate: $($leaf.Subject)"
Write-Res INFO "Issued by:          $($leaf.Issuer)"
Write-Res INFO "Names (SAN):        $(Get-San $leaf)"
Write-Res INFO "Valid:              $($leaf.NotBefore.ToString('yyyy-MM-dd')) to $($leaf.NotAfter.ToString('yyyy-MM-dd'))"
Write-Res INFO "Issuer key id:      $aki"
if ($leaf.Subject -eq $leaf.Issuer) { Write-Res WARN "The server certificate is self-signed (no CA). Reissue it from the local CA on the server: sudo bash cert-tool.sh reissue" }

# 2. Is it the expected certificate, or did something replace it on the way?
if ($leaf.Issuer -notmatch 'FreeScout|Sync Manager|Local (Root )?CA') {
  Write-Res WARN "The issuer is not one of the local CAs. If it names your antivirus or firewall, that product is inspecting HTTPS and"
  Write-Res WARN "  replacing the certificate - exclude this site from HTTPS scanning / SSL decryption, or trust that product's CA."
}

# 3. Which CA certificates on this PC match (or almost match) the issuer
$all = @(Get-StoreCerts)
$exact = @($all | Where-Object { $aki -and $_.Ski -eq $aki })
$sameName = @($all | Where-Object { $_.Cert.Subject -eq $leaf.Issuer -and $_.Ski -ne $aki })
$leafInRoot = @($all | Where-Object { $_.Cert.Thumbprint -eq $leaf.Thumbprint -and $_.Store -like '*\Root' })

foreach ($m in $exact) {
  $kind = if ($m.Store -like '*\Root') { 'PASS' } elseif ($m.Store -like '*\Disallowed') { 'FAIL' } else { 'WARN' }
  $why = switch -Wildcard ($m.Store) { '*\Root' { 'trusted root store (correct)' } '*\Disallowed' { 'UNTRUSTED store - remove it there' } '*\CA' { 'Intermediate store - must be in Trusted Root' } default { 'Personal store - must be in Trusted Root' } }
  Write-Res $kind "Issuing CA found in $($m.Store): $why  [thumbprint $($m.Cert.Thumbprint)]"
}
if (-not $exact) { Write-Res FAIL "The CA that signed this site's certificate is NOT installed on this PC (no certificate with key id $aki)." }
foreach ($m in $sameName) {
  Write-Res FAIL "Stale CA in $($m.Store): same name '$($m.Cert.Subject)' but a DIFFERENT key (from an older install) [thumbprint $($m.Cert.Thumbprint)] - remove it"
}
foreach ($m in $leafInRoot) { Write-Res WARN "The SERVER certificate itself is in $($m.Store). That doesn't make the site trusted - the CA certificate is needed." }

# 4. Windows' verdict (Chrome and Edge use the same Windows trust stores)
$t = Test-Trust $leaf
if ($t.Ok) { Write-Res PASS "Windows trusts this certificate chain." }
else {
  Write-Res FAIL "Windows does not trust the chain: $($t.Status -join ', ')"
  if ($t.Status -contains 'PartialChain') { Write-Res INFO "  PartialChain = the issuing CA isn't installed (or the wrong one is)." }
  if ($t.Status -contains 'UntrustedRoot') { Write-Res INFO "  UntrustedRoot = the CA was found but not in Trusted Root Certification Authorities." }
  if ($t.Status -contains 'NotTimeValid') { Write-Res INFO "  NotTimeValid = check this PC's clock and the server's." }
}

# 5. Optional fix: download the CA from the server, check it's the right one, install it
if ($Fix) {
  Write-Host "`nFixing" -ForegroundColor White
  $ca = $null
  foreach ($name in 'freescout-ca.crt', 'fsmanager-ca.crt') {
    try {
      $resp = (New-Object System.Net.Http.HttpClient).GetAsync("http://$($uri.Host)/$name").Result
      if (-not $resp.IsSuccessStatusCode) { continue }
      $bytes = $resp.Content.ReadAsByteArrayAsync().Result
      $cand = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(, $bytes)
      if ((Get-Ski $cand) -eq $aki) { $ca = $cand; Write-Res PASS "Downloaded http://$($uri.Host)/$name - it is the CA that signed this site"; break }
      else { Write-Res INFO "http://$($uri.Host)/$name is a different CA - skipped" }
    } catch { }
  }
  if (-not $ca) { Write-Res FAIL "Could not download the matching CA from http://$($uri.Host)/. Copy *-ca.crt from the server (/etc/ssl/freescout or /etc/ssl/fsmanager) and run: certutil -addstore -f Root <file>"; exit 1 }
  $admin = $false
  try { $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { }
  $loc = if ($admin) { 'LocalMachine' } else { 'CurrentUser' }
  foreach ($m in $sameName + @($exact | Where-Object { $_.Store -notlike '*\Root' })) {
    try {
      $parts = $m.Store -split '\\'
      $s = New-Object System.Security.Cryptography.X509Certificates.X509Store($parts[1], $parts[0]); $s.Open('ReadWrite'); $s.Remove($m.Cert); $s.Close()
      Write-Res PASS "Removed $($m.Cert.Subject) from $($m.Store)"
    } catch { Write-Res WARN "Could not remove from $($m.Store) (run as Administrator): $($m.Cert.Thumbprint)" }
  }
  $s = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', $loc); $s.Open('ReadWrite'); $s.Add($ca); $s.Close()
  Write-Res PASS "Installed '$($ca.Subject)' in $loc\Root$(if (-not $admin) { ' (current user only - run elevated to install for all users)' })"
  $t = Test-Trust $leaf
  if ($t.Ok) { Write-Res PASS "Windows now trusts the site. Close ALL Chrome/Edge windows (check the system tray) and reopen." }
  else { Write-Res FAIL "Still not trusted: $($t.Status -join ', ')" }
}
Write-Host ""
