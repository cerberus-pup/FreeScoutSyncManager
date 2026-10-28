# Security

The Sync Manager can replace the database and files of every FreeScout server it manages; that's what a restore does. Protect the manager server like the help desks themselves: keep it patched, limit who can log in, and restrict its web port to your admin network.

## Security model

**SSH and the agent**

- The manager has its own SSH key (`/var/lib/fsmanager/ssh/id_ed25519`). On each FreeScout server, the key is authorized only for the `fsagent` user. The key entry uses `restrict` (no shell, PTY or forwarding), a forced command, and optionally `from="<manager IP>"`.
- The forced command (`/usr/local/sbin/fs-agent-ssh`) accepts only a fixed list of sub-commands made of plain words, then calls `sudo /usr/local/sbin/fs-agent`. That is the only thing `fsagent` may run as root.
- File copies go through `fs-agent rsync`. It only allows rsync's server mode, rejects protected-args mode and unknown options, and refuses any path outside that server's FreeScout directory.
- The manager records each server's SSH host key on first contact and refuses a changed key.

**Secrets**

- Database passwords are read from FreeScout's `.env` on each server and never leave it, and `.env` is never copied between servers.
- `APP_KEY` is stored in each snapshot (mode 600, owned by the `fsmanager` service user), because the target needs it to decrypt mailbox passwords and attachment links. Snapshots therefore contain everything needed to read the help desk: protect the backup disk.

**Web app**

- Passwords are hashed with scrypt.
- Session cookies are HttpOnly and SameSite=Strict.
- Every change needs a custom request header (CSRF guard).
- Logins are throttled, and pages use a strict Content-Security-Policy.
- The Node.js app listens on 127.0.0.1 only; nginx terminates TLS.
- The service runs as an unprivileged `fsmanager` user with systemd sandboxing.

**What's never committed to this repository**

There are no keys, certificates, `.env` files or databases in the repository; `.gitignore` blocks them. Each install generates its own CA, SSH key and admin account.

## Reporting a problem

Please don't open a public issue for a security problem. Use GitHub's **Report a vulnerability** (Security tab → Advisories) on this repository, or contact the maintainers privately. Include the version (`fs-agent version`, the app version in the CHANGELOG) and steps to reproduce.
