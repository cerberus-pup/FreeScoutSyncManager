# Troubleshooting

## Where to look

| What | Where |
|---|---|
| A run's full log | **Runs** → the run (also `/var/lib/fsmanager/logs/run-<id>.log`) |
| Manager service | `sudo journalctl -u fsmanager -n 100 --no-pager` |
| Manager install / upgrade | `/var/log/fsmanager-install.log` |
| nginx on the manager | `/var/log/nginx/error.log` |
| Agent on a FreeScout server | `sudo /usr/local/sbin/fs-agent info` and `sudo /usr/local/sbin/fs-agent health` |
| FreeScout itself | `storage/logs/laravel.log` in the FreeScout folder |
| FreeScout installer | `/var/log/freescout-install.log` |

## Common errors

| Message | Cause and fix |
|---|---|
| `Host key verification failed` | The server's SSH host key changed (rebuilt or reinstalled). If that's expected: **Instances → Edit → Reset host key**, then **Check now**. |
| `Permission denied (publickey)` | The agent isn't installed for that SSH user, or the key is locked to a different manager IP. Re-run the agent install command. If the manager's IP changed: `cd /opt/fsmanager/app && sudo -u fsmanager env FSM_DATA=/var/lib/fsmanager node dist/cli.js set-setting agent_from <new IP>`, then re-run the agent install command on each server. |
| `the agent on X is version …; … or newer is needed` | Update the agent on that server ([updating.md](updating.md#agents-each-freescout-server)). Nothing was changed. |
| `Target runs FreeScout X, which is OLDER than the source's Y` | Update FreeScout on the target first, or set "What to copy" to **Everything** to clone the source's version onto it. |
| `X is ACTIVE … and has N conversations - a sync would overwrite them` | The target handles mail. If it really is a spare, use **Turn mail off** on it first. If it's your new production server, delete the sync job. |
| `target has … free; about … needed` | Free up disk space on the target. |
| `database dump has only N tables` | The source dump is incomplete. Check the run log for the `mariadb-dump` error and disk space on the source and the manager. Files already copied are kept, so the next attempt resumes. |
| `… is in maintenance mode (a restore may have stopped part-way)` | Re-run the restore, or roll back by hand (below). |
| `No cron entry runs this FreeScout's scheduler` (Instances page) | FreeScout's `schedule:run` cron line is missing, so the server never fetches mail even when it's active. Add it: `* * * * * www-data php /var/www/freescout/artisan schedule:run >> /dev/null 2>&1` in `/etc/cron.d/freescout`. |
| `ERROR 1406 Data too long for column 'license'` | Fixed in agent 1.2.1. Update the agent on the target. |
| Browser: `NET::ERR_CERT_…` | See [certificates.md](certificates.md). |

## Rolling back a target by hand

Every restore saves the target's database first, so a cancelled or failed restore can be undone:

```bash
sudo ls -t /var/backups/fs-agent/          # newest safety dump first
gunzip -c /var/backups/fs-agent/fs-agent-pre-restore-YYYYMMDD-HHMMSS.sql.gz | sudo mariadb freescout
sudo -u www-data php /var/www/freescout/artisan freescout:clear-cache
sudo -u www-data php /var/www/freescout/artisan up
```

Use your database name and FreeScout path. For a second install set up with `--name b`, the files start with `fs-agent-b-`. Alternatively, restore the target's own latest snapshot from the **Backups** page.

## Reset a forgotten admin password

On the manager:

```bash
cd /opt/fsmanager/app && sudo -u fsmanager env FSM_DATA=/var/lib/fsmanager node dist/cli.js set-password admin
```

## Why database and file sizes differ between servers

After a successful sync, the **Database** and **Attachments and files** sizes on the Instances page usually don't match. That's normal. The proof that the copy is complete is the **row-count comparison** on the run page, which should say "Match".

**Database size** comes from MariaDB's table statistics (`data_length + index_length`). It counts allocated storage, not data:

- Years of deletes and updates leave free space inside the source's tables. A restored copy is rebuilt from scratch and packed tightly, so it's often 10–40% smaller with identical data.
- The statistics are sampled estimates, and MariaDB 10.5 and 11.8 store and estimate differently.
- Newer FreeScout versions add indexes and change columns during the upgrade, which can make some tables larger.
- The source keeps changing after the snapshot (new mail, activity and send logs, job queues).

**Attachments and files** is `du` of `storage/app`:

- New mail and attachments arrive on the active server after each sync.
- Each server cleans up its own temporary files, and the destination keeps its own SSO folders.
- Directory sizes are included, and they differ between filesystems and with the folder's history.
- The **Backups** page's "Files" figure is the whole FreeScout folder (code, vendor libraries and modules too), so it never matches the Instances figure.

To compare the attachments themselves, run this on each server right after a sync (adjust the path):

```bash
sudo find /var/www/freescout/storage/app/attachment -type f -printf '%s\n' | awk '{n++; s+=$1} END {printf "%d files, %.2f GB\n", n, s/1e9}'
```

## Files on each machine

| Path | What |
|---|---|
| `/opt/fsmanager/app` | Web app (`dist/` is the compiled build) |
| `/opt/fsmanager/agent` | Agent files served at `/agent/install.sh` |
| `/var/lib/fsmanager/` | SQLite database, SSH key, `backups/<instance-id>/<timestamp>/`, run logs (or the data folder you chose) |
| `/etc/fsmanager/install.conf` | Answers from the first install, used for upgrades |
| `/etc/systemd/system/fsmanager.service` | Service |
| `/etc/nginx/sites-available/fsmanager.conf` | HTTPS front end |
| `/etc/ssl/fsmanager/` | Local CA and server certificate |
| On FreeScout servers: `/usr/local/sbin/fs-agent*`, `/etc/fs-agent.conf`, `/etc/sudoers.d/fs-agent` | Agent |
| On FreeScout servers: `/var/backups/fs-agent/` | Safety dumps taken before each restore (last 3) |
| On FreeScout servers: `/var/lib/fs-agent/` | Agent state (kept SSO settings during a restore) |
