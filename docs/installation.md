# Installation

You need:

- **One Ubuntu server for the manager** (22.04, 24.04 or 26.04). It keeps the snapshots, so give it disk space for at least one full copy of each FreeScout database and its attachments, plus room for changes. A separate disk mounted for backups is ideal.
- **Each FreeScout server** reachable from the manager over SSH, with `sudo`.

## 1. Install the manager

### Option A: from GitHub (the manager has internet access)

```bash
sudo apt-get install -y git
git clone https://github.com/<you>/freescout-sync-manager.git
cd freescout-sync-manager
sudo bash install.sh
```

### Option B: copy a release archive from a Windows PC

Build or download `fsmanager.tar.gz` first. Download it from the GitHub Actions run or release page, or build it with `bash scripts/make-release.sh` on any Linux/WSL machine. Then, in **PowerShell** on Windows (OpenSSH is built into Windows 10 and 11):

```powershell
cd $HOME\Downloads
scp .\fsmanager.tar.gz youruser@192.168.1.50:~/
ssh youruser@192.168.1.50
```

On the Ubuntu server:

```bash
tar xzf fsmanager.tar.gz
cd fsmanager
sudo bash install.sh
```

### What the installer asks

| Prompt | Notes |
|---|---|
| Hostname for the manager | e.g. `fsmanager.example.local`. This is the address you'll open in the browser. |
| HTTPS mode | **1** local CA (a certificate Chrome and Edge accept once the CA is trusted), **2** your own certificate and key (e.g. from AD CS), **3** HTTP only |
| Certificate details (local CA only) | Organization, Department, City, State, Country. Blank fields are left out of the certificate; Country defaults to US. |
| Where to keep data and backups | Default `/var/lib/fsmanager`. Choose a path on your big disk. |
| Lock agent SSH keys to this manager's IP | Recommended. Adds `from="<manager IP>"` to every agent key. |
| Time zone for schedules | e.g. `America/Los_Angeles` |
| Admin username and password | Password at least 10 characters |
| Disable nginx's default site | Yes on a dedicated server |

The installer also sets up:

- Node.js: Ubuntu's own if it's 22.13 or newer, otherwise NodeSource 24 LTS.
- The app in `/opt/fsmanager`, built from source on the server.
- The `fsmanager` systemd service, running as its own `fsmanager` user and listening on 127.0.0.1 only.
- nginx as the HTTPS front end.

Everything it does is logged to `/var/log/fsmanager-install.log`.

**Presetting the certificate details.** To skip typing them, set environment variables; they become the prompts' defaults:

```bash
sudo CERT_O="Example Inc" CERT_OU="IT" CERT_L="Springfield" CERT_ST="Oregon" CERT_C="US" bash install.sh
```

**Trust the CA on your PCs** (local CA mode). Download `http://<manager>/fsmanager-ca.crt` and import it into **Trusted Root Certification Authorities**, or push it with Group Policy. See [certificates.md](certificates.md).

## 2. Install the agent on each FreeScout server

In the web app, open **Settings** (or **Instances → Add instance**) and copy the install command. It looks like this:

```bash
curl -fsSk https://fsmanager.example.local/agent/install.sh -o install-agent.sh && sudo bash install-agent.sh
```

Run it on the FreeScout server. Options:

| Option | Use when |
|---|---|
| `--dir /var/www/html` | FreeScout isn't in `/var/www/freescout` |
| `--name b` | A second FreeScout on the same server; its SSH user becomes `fsagent-b` |
| `--from 10.0.0.5` | Override the manager IP the key is locked to |

The agent installer:

- Creates the `fsagent` user and authorizes the manager's key for it (forced command, no shell).
- Installs `/usr/local/sbin/fs-agent` and `fs-agent-ssh`.
- Writes `/etc/sudoers.d/fs-agent` and `/etc/fs-agent.conf`.
- Warns if it can't find FreeScout's `schedule:run` cron job.

Check it with:

```bash
sudo /usr/local/sbin/fs-agent version     # fs-agent 1.2.1
sudo /usr/local/sbin/fs-agent info
```

## 3. Add instances

In **Instances → Add instance**, enter:

- **Name:** anything recognizable, e.g. *Production*
- **Host:** IP address or hostname
- **Port:** 22
- **SSH user:** `fsagent`

Click **Add and check**. The first connection records the server's SSH host key fingerprint; later connections refuse a different key. If you rebuild a server, open **Edit** on the instance and use **Reset host key**.

## 4. Create jobs

| Job | Source | Target | Typical schedule |
|---|---|---|---|
| Backup | production | none | daily |
| Sync | production | standby server | hourly or daily |
| Migration | old server | new server | manual, once |

Run a backup first and check its result under **Runs**. For a migration, read [user-guide.md](user-guide.md#different-freescout-or-mariadb-versions) first.

## Firewall

| From | To | Port |
|---|---|---|
| Your PCs | manager | 443 (and 80, which redirects to 443 and serves the CA file) |
| Manager | each FreeScout server | 22 |
| Each FreeScout server | manager | 443, only while installing or updating the agent |
