# HTTPS certificates

Both installers (the manager's `install.sh` and `freescout-installer/freescout-install.sh`) can create a **local certificate authority (CA)** and sign the server's certificate with it. This is the usual choice for `.local` and other internal names, where Let's Encrypt can't be used.

The server certificate meets current Chrome, Edge, Firefox and Safari rules:

- **Subject Alternative Names (SAN)** for the full name, the short name and every server IP. Chrome and Edge ignore the CN.
- Valid for 820 days. Safari and macOS reject private certificates valid for more than 825 days.
- SHA-256 and `CA:FALSE`, with the `serverAuth` extended key usage and Subject/Authority Key Identifiers.
- Your Organization, Department (OU), City, State and Country in the subject, if you enter them. Blank fields are left out; Country defaults to US.

Both installers and `cert-tool.sh reissue` ask for these details. To preset them, for example for an unattended reissue, set environment variables:

```bash
sudo CERT_O="Example Inc" CERT_OU="IT" CERT_L="Springfield" CERT_ST="Oregon" CERT_C="US" bash install.sh
```

## Trusting the CA on Windows PCs

Each server serves its CA certificate over plain HTTP:

| Server | CA file |
|---|---|
| Sync Manager | `http://<manager>/fsmanager-ca.crt` |
| FreeScout | `http://<helpdesk>/freescout-ca.crt` |

Import it into **Local Computer → Trusted Root Certification Authorities**. Pick that store yourself rather than letting the wizard choose. For many PCs, push it with Group Policy (*Computer Configuration → Windows Settings → Security Settings → Public Key Policies → Trusted Root Certification Authorities*). Fully close and reopen the browser afterwards.

### `tools/Test-SiteCertificate.ps1`

Run this on a PC that shows a certificate warning. It fetches the certificate the server actually sends and matches it against the CAs in the PC's certificate stores by key identifier. It finds:

- a missing CA
- a CA imported into the wrong store
- an old CA with the same name left over from an earlier install
- a broken chain

```powershell
powershell -ExecutionPolicy Bypass -File .\Test-SiteCertificate.ps1 -Url https://helpdesk.example.local
```

With `-Fix`, run from an elevated PowerShell, it downloads the server's CA, checks that it really signed the certificate, removes stale CAs with the same name, and imports it into Trusted Root:

```powershell
powershell -ExecutionPolicy Bypass -File .\Test-SiteCertificate.ps1 -Url https://helpdesk.example.local -Fix
```

It works with Windows PowerShell 5.1 and PowerShell 7.

## `tools/cert-tool.sh` (on the server)

Use this on the manager and on FreeScout servers set up with these installers:

```bash
sudo bash tools/cert-tool.sh check             # says exactly which browser rule the certificate breaks
sudo bash tools/cert-tool.sh reissue           # new server cert from the existing CA
sudo bash tools/cert-tool.sh reissue --new-ca  # also replace the CA (PCs must trust the new one)
sudo bash tools/cert-tool.sh install-renewal   # daily check; reissues 45 days before expiry
```

`check` covers:

- SAN present and covering every `server_name`
- key usage and extended key usage
- signature algorithm and validity dates
- chain and key match
- what nginx is actually serving

`reissue` adds every name nginx answers to, the short name, all server IPs and the organization details, then reloads nginx. It keeps the CA, so PCs that already trust it need nothing new.

To use it on a FreeScout server, copy `tools/cert-tool.sh` there (e.g. with `scp`) and run it the same way.

## Certificates from your own CA (AD CS)

`check` still diagnoses them. Chrome and Edge ignore the CN, so the request must include SAN entries. With `certreq` or the Web Enrollment page, add an attribute like:

```
san:dns=helpdesk.example.local&dns=helpdesk&ipaddress=192.168.1.20
```

## What the browser error means

| Error | Fix |
|---|---|
| `ERR_CERT_COMMON_NAME_INVALID` | The address you typed isn't in the certificate's SAN list, or there is no SAN. Run `cert-tool.sh reissue`. |
| `ERR_CERT_AUTHORITY_INVALID` | The PC doesn't trust the CA, or trusts an older CA with the same name. Run `Test-SiteCertificate.ps1 -Fix`. |
| `ERR_CERT_DATE_INVALID` | A clock is wrong, or the certificate has expired. Run `cert-tool.sh reissue` and `install-renewal`. |
