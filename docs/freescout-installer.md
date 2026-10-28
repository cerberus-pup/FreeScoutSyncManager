# FreeScout installer

`freescout-installer/freescout-install.sh` installs FreeScout on a fresh Ubuntu Server 22.04, 24.04 or 26.04: Nginx, PHP-FPM, MariaDB, FreeScout from its official Git repository, cron and HTTPS. It's a standalone replacement for FreeScout's own `tools/install.sh` and doesn't need the Sync Manager.

## Run it

From the repository:

```bash
sudo bash freescout-installer/freescout-install.sh
```

Or copy just the script from a Windows PC (PowerShell):

```powershell
scp .\freescout-install.sh youruser@192.168.1.20:~/
ssh youruser@192.168.1.20
```

```bash
sudo bash ~/freescout-install.sh
```

The installer asks every question up front, then runs unattended. Everything is logged to `/var/log/freescout-install.log`, and a summary (URLs, database credentials, paths) is saved to `/root/freescout-install-info.txt`. It's safe to re-run.

## What it asks

| Prompt | Notes |
|---|---|
| Help desk hostname | e.g. `helpdesk.example.local`, a public name, or an IP |
| Install directory | Default `/var/www/freescout` |
| HTTPS | **1** local CA + server certificate (recommended for `.local`), **2** your own certificate files (e.g. AD CS), **3** Let's Encrypt (public names only), **4** HTTP only |
| Certificate details (option 1) | Extra names and IPs, validity (default 820 days), Organization, Department, City, State, Country |
| mDNS (Avahi) | Announces a `.local` name on the LAN. Say no if you'll add a DNS record. |
| Time zone, max upload size | |
| Internal hosts | e.g. an on-prem mail server FreeScout must connect to |
| PHP version | See below |
| Automatic security updates | Turns on `unattended-upgrades` so PHP stays patched |
| Setup method | **1** finish from the command line (creates the tables and your admin user), **2** leave it to the web installer |
| Nightly FreeScout updates | Optional, runs FreeScout's `tools/update.sh` at 01:00 |

## PHP policy: never a vulnerable or end-of-life PHP

The installer only offers PHP branches with at least 90 days of upstream security support left:

| Ubuntu | Default PHP | Notes |
|---|---|---|
| 22.04 | PHP 8.3 or 8.4 from `ppa:ondrej/php` | Ubuntu's PHP 8.1 is end-of-life, and FreeScout warns against it |
| 24.04 | Ubuntu's PHP 8.3, or 8.4 from the PPA | |
| 26.04 | Ubuntu's PHP 8.5 | The PPA has no packages for 26.04 yet; the installer checks and falls back |

It also:

- Confirms the `-security` pocket is enabled.
- Upgrades every installed PHP package to the newest patched build and checks that none is behind what the repositories offer.
- Offers to remove unsupported PHP branches left by other installers.

Ubuntu's PHP packages keep the base version number (e.g. `8.3.6-0ubuntu…`) while Canonical backports security fixes, so a scanner that only reads version strings may flag them falsely.

`php-imap` isn't packaged for PHP 8.5 on Ubuntu 26.04. FreeScout 1.8.x fetches mail without it, so the installer treats it as optional.

## After installing

- **Local CA:** trust `http://<helpdesk>/freescout-ca.crt` on your PCs ([certificates.md](certificates.md)).
- Log in, add your mailboxes, and send a test email.
- To back it up or sync it with the Sync Manager, install the agent ([installation.md](installation.md#2-install-the-agent-on-each-freescout-server)).
