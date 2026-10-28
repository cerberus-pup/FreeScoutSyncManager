# FreeScout Sync Manager

A self-hosted web app that **backs up, syncs and migrates [FreeScout](https://freescout.net) help desks** between Ubuntu servers. It runs on its own small Ubuntu server, talks to each FreeScout server over a locked-down SSH agent, and shows every run step by step, ending with a row-count comparison between source and target.

The repository also includes a **working interactive FreeScout installer** for Ubuntu 22.04, 24.04 and 26.04. It supports `.local` domains with a self-generated certificate trusted by Chrome and Edge, and never installs an unsupported PHP version.

| | |
|---|---|
| **Backup** | Database dump, `APP_KEY` and every application file (attachments, modules, uploads, code). Snapshots are incremental: unchanged files are hard-linked to the previous snapshot. |
| **Sync** | Backs up the source and restores it onto the target, which is left in **standby**, for a warm spare. |
| **Migration** | One-time move: copies the source onto the target, makes the target **active**, and can put the source in standby. |
| **Restore** | Any snapshot onto any instance, in standby or active mode. |
| **Mail switch** | Turn mail on for one server and off on others in a single checked step, so two servers never fetch the same mailboxes. |

Highlights:

- **Different versions on each side.** Works from older to newer FreeScout (e.g. 1.8.154 → 1.8.248) and MariaDB (e.g. 10.5 → 11.8). A data-only copy lets the target keep its newer code, and FreeScout's own migrations upgrade the copied database.
- **The destination's SSO stays intact.** The destination's own SAML, OAuth and LDAP settings, module licenses and certificates are kept and re-encrypted with the new `APP_KEY`.
- **Safe restores.** Each restore saves a safety dump of the target first, rolls back automatically if the import fails, refuses to downgrade, and refuses to overwrite an active server that already has conversations.
- **Locked-down access.** The agent uses a forced-command SSH key with no shell. It allows only a fixed set of commands, and file copies are confined to the FreeScout directory.

## How it works

```
                 HTTPS (browser)
                       │
              ┌────────▼─────────┐
              │  Sync Manager    │  Node.js app + nginx + SQLite
              │  (own Ubuntu VM) │  snapshots in /var/lib/fsmanager/backups
              └───┬──────────┬───┘
       SSH (forced command, rsync)
                  │          │
       ┌──────────▼──┐   ┌───▼─────────┐
       │ FreeScout A │   │ FreeScout B │   each runs fs-agent
       │  (active)   │   │  (standby)  │   (sudo-limited helper)
       └─────────────┘   └─────────────┘
```

## Quick start

**1. Manager server** (a separate Ubuntu 22.04 / 24.04 / 26.04 machine):

```bash
git clone https://github.com/<you>/freescout-sync-manager.git
cd freescout-sync-manager
sudo bash install.sh
```

**2. Each FreeScout server.** Copy the agent install command from the web app (**Settings** or **Instances → Add instance**) and run it there:

```bash
curl -fsSk https://fsmanager.example.local/agent/install.sh -o install-agent.sh && sudo bash install-agent.sh
```

**3. In the web app,** add each server as an instance (SSH user `fsagent`), then create a backup, sync or migration job.

The full walkthrough is in [docs/installation.md](docs/installation.md).

**Need a FreeScout server first?** See [docs/freescout-installer.md](docs/freescout-installer.md):

```bash
sudo bash freescout-installer/freescout-install.sh
```

## Documentation

| Guide | What's in it |
|---|---|
| [Installation](docs/installation.md) | Manager install, agent install, adding instances, first jobs, installing without Git (from Windows) |
| [Updating](docs/updating.md) | Updating the manager and the agents, from Git or a release archive |
| [User guide](docs/user-guide.md) | Active/standby, jobs, mail switch, version differences, SSO, what a restore does, after a migration |
| [Certificates](docs/certificates.md) | Local CA, Chrome/Edge rules, `cert-tool.sh`, the Windows `Test-SiteCertificate.ps1` checker |
| [Troubleshooting](docs/troubleshooting.md) | Logs, common errors, rollback by hand, password reset, why sizes differ between servers |
| [FreeScout installer](docs/freescout-installer.md) | The standalone FreeScout install script |
| [Security](SECURITY.md) | Security model and how to report a problem |
| [Changelog](CHANGELOG.md) | Versions of the app and the agent |

## Repository layout

```
install.sh                   Manager installer / upgrader (run on the manager server)
app/                         Web app: TypeScript source (src/), browser UI (public/)
agent/                       Agent installed on each FreeScout server
  install-agent.sh             agent installer (served by the manager at /agent/install.sh)
  fs-agent                     root helper: dump, restore, rsync, maintenance, standby, finalize...
  fs-agent-ssh                 SSH forced command that whitelists fs-agent sub-commands
tools/
  cert-tool.sh                 check / reissue / auto-renew HTTPS certificates (Linux)
  Test-SiteCertificate.ps1     diagnose and fix certificate trust on a Windows PC
freescout-installer/
  freescout-install.sh         interactive FreeScout installer for Ubuntu
scripts/make-release.sh      Builds fsmanager.tar.gz for copying to a server without Git
docs/                        Guides
```

## Requirements

- **Manager:** Ubuntu 22.04, 24.04 or 26.04, with disk space for your databases and attachments. Node.js 22.13+ is installed automatically.
- **FreeScout servers:** Ubuntu or Debian with FreeScout on MySQL/MariaDB (PostgreSQL isn't supported), SSH reachable from the manager, and `sudo`. The agent installer adds `rsync` if it's missing.

## Versions

- App: 1.0.0
- Agent: 1.2.1

The manager refuses to run against older agents where a feature needs a newer one, and says which command updates them.

## License

[MIT](LICENSE). FreeScout itself is a separate project licensed under AGPL-3.0. This tool only operates FreeScout installations; it does not include FreeScout code.
