# Changelog

The web app and the agent have separate version numbers. When the agent changes, re-run the agent install command on every FreeScout server ([docs/updating.md](docs/updating.md)).

## App 1.0.0, agent 1.2.1 (first public release)

**Sync Manager**

- Backups, syncs, migrations and restores between FreeScout servers, with a step-by-step log and a source/target row-count comparison for every run.
- Incremental snapshots (rsync hard links). An interrupted backup resumes where it stopped, and the full dump is verified before a snapshot is accepted.
- Works across versions: older to newer FreeScout via a data-only copy, and MariaDB 10.5 ↔ 11.x dump cleanup (sandbox-mode line, `uca1400` collations).
- Keeps the destination's own SSO setup (SAML / OAuth / LDAP settings, module licenses and certificates), re-encrypted with the new `APP_KEY`.
- Active/standby handling, plus a **Mail switch** that turns mail on for one server and off on the others, with pre-checks and automatic rollback.
- Safety guards:
  - Refuses to downgrade.
  - Refuses to sync over an active server that has conversations.
  - Pauses old sync jobs after a migration.
  - Saves a safety dump before every restore and rolls back automatically if the import fails.
- Installer and upgrader for Ubuntu 22.04 / 24.04 / 26.04 with a local CA, nginx TLS and a systemd service.

**Tools**

- `tools/cert-tool.sh`: check, reissue and auto-renew HTTPS certificates to current browser rules.
- `tools/Test-SiteCertificate.ps1`: diagnose and fix certificate trust on Windows PCs.
- `freescout-installer/freescout-install.sh`: interactive FreeScout installer with a strict PHP security policy and `.local` / local CA support.
- Certificate details (organization, department, city, state, country) are asked during install; blank fields are left out. They can be preset with `CERT_O`, `CERT_OU`, `CERT_L`, `CERT_ST` and `CERT_C`.

### Agent history

- **1.2.1:** The destination's SSO rows are saved before the import and re-applied after FreeScout's migrations, with encrypted values re-encrypted for the new `APP_KEY`. Fixes `ERROR 1406 Data too long for column 'license'` when the source runs FreeScout 1.8.154.
- **1.2.0:** Keeps the destination's SSO settings (`restore-db --keep-sso`, `sso-keep-preview`).
- **1.1.0:** Cross-version restores (MariaDB dump cleanup, per-module install in finalize). Minimum version the manager accepts for restores.
