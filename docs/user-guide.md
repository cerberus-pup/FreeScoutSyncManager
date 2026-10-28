# User guide

- [Pages](#pages)
- [Active vs standby (mail on / mail off)](#active-vs-standby-mail-on--mail-off)
- [Switching which server handles mail](#switching-which-server-handles-mail)
- [Jobs](#jobs)
- [Different FreeScout or MariaDB versions](#different-freescout-or-mariadb-versions)
- [SSO on the destination](#sso-on-the-destination)
- [What a restore does on the target](#what-a-restore-does-on-the-target)
- [After a migration](#after-a-migration)

## Pages

| Page | What it shows |
|---|---|
| **Overview** | Each job as a lane (source → target), last result, next scheduled run, storage used |
| **Instances** | Each FreeScout server: version, PHP, database version, conversations, sizes, agent version, mail on/off. Buttons: **Check now**, **Back up now**, **Turn mail on…** / **Turn mail off**, **Edit** |
| **Jobs** | Backup, sync and migration jobs with their options and schedules |
| **Runs** | Every run step by step with its log, the source/target row-count comparison, and notes (data-only copy, SSO kept, final mode) |
| **Backups** | Snapshots per instance: pin (never pruned), download the database dump, restore onto any instance, delete |
| **Settings** | Agent install command, restricting the agent key to the manager's IP, the manager's SSH public key, your password |

## Active vs standby (mail on / mail off)

A FreeScout server that runs its scheduler (the `schedule:run` cron job) fetches mail from the mailboxes and sends replies. If two servers do that for the same mailboxes, mail is split between them and customers get duplicate replies. The manager keeps every copy in **standby** (mail off). In standby the site is up and readable, but its scheduler is paused (its cron line is commented out with `#FSAGENT-STANDBY#`) and its queue workers are stopped. Only one server should be **active** (mail on) per set of mailboxes.

- A sync always leaves the target in standby.
- A migration makes the target active (unless you untick that option) and can put the source in standby.
- A sync refuses to overwrite a target that is active and already has conversations.
- A migration automatically pauses sync jobs that point at the server it just made active, so an old sync can't overwrite the new production server.

**Sync is one-way.** Two FreeScout servers can't safely merge each other's tickets, because both hand out the same conversation and thread IDs. The target of a sync is always a copy of the source.

## Switching which server handles mail

On **Instances**, a server with mail off has **Turn mail on…**. It asks which other servers to turn mail off on (servers with mail on are pre-ticked), then runs as a "Mail switch" under **Runs**:

1. It checks that the server getting mail, and every server to turn off, can be reached. If one can't, nothing changes, unless **turn mail on anyway** is ticked (for when that server is down).
2. It turns mail off on the chosen servers, then on for the selected one. If that last step fails, the servers that had mail on get it back.
3. It checks every instance and lists which ones have mail on, with a warning if more than one does.

**Failover:** on the standby server, click **Turn mail on…** and tick the failed production server. If production is down, also tick **turn mail on anyway**, then turn production's mail off once it's back.

**Turn mail off** on a server with mail on affects just that one server.

## Jobs

| Option | Meaning |
|---|---|
| Type | Backup (source only), Sync (source → target, target left in standby), Migration (source → target) |
| Schedule | Manual, every N hours, daily or weekly, at a time in the manager's time zone |
| Snapshots to keep | How many unpinned snapshots of the source to keep; older ones are pruned |
| What to copy | **Automatic** (recommended), **Everything** or **Data only**. See below. |
| Keep the target's own SSO setup | On by default. See below. |
| Make the target active when the copy finishes | Migration only |
| Put the source in standby afterwards | Migration only |
| Job is enabled | Untick to pause scheduled runs |

Runs execute one at a time, in order. A running run can be cancelled from its page. If a restore is cancelled or fails partway, the target may stay in maintenance mode; its safety dump lets you roll back (see [troubleshooting.md](troubleshooting.md#rolling-back-a-target-by-hand)).

## Different FreeScout or MariaDB versions

**What gets copied** (the job option "What to copy", default **Automatic**):

| Source vs target FreeScout | Automatic does | Why |
|---|---|---|
| Same version | Everything: an exact copy, including code and modules | Identical servers |
| Target is **newer** (e.g. 1.8.154 → 1.8.248) | **Data only**: the database, `storage/app` (attachments, uploads) and modules. The target keeps its own FreeScout code, and FreeScout's migrations upgrade the copied database the same way an in-place update would. | Old code may not run on the new server's PHP, and you don't want to downgrade the new server |
| Target is **older** | Refused before anything is touched | A newer database can't run on older FreeScout code. Update the target first, or choose "Everything" to clone the source's version onto it. |

Modules in a data-only copy: a module the target doesn't have, or has in an older version, is copied. If the target already has the same or a newer version, its own copy is kept. Module links (`public/modules/...`) and module migrations are redone on the target after every copy.

**MariaDB/MySQL versions.** Dumps are plain SQL from `mariadb-dump`, which newer servers import fine (e.g. 10.5 → 11.8). For the other direction, the agent cleans each dump before importing it:

- It removes the "sandbox mode" first line written by MariaDB 10.5.25+, 10.6.18+ and 11.x, which older clients reject.
- On servers without `uca1400` collations (before 10.10), it maps `utf8mb4_uca1400_*` to `utf8mb4_unicode_ci`.

**After moving to the newer server, don't sync back to the old one.** Once a database has been upgraded, it only fits the newer FreeScout. Keep the old server in standby until you're satisfied, then retire it.

## SSO on the destination

Sync, migration and restore keep the **destination's own SSO setup** by default ("Keep the target's own SSO setup" on each job and restore). SSO is tied to each server's address (ACS and redirect URLs, IdP app registrations, domain-bound module licenses), so the source's settings would break sign-in on the destination. A backup never writes to any server, so it's unaffected.

The destination's rows are saved before the import and put back at the end of the finalize step, after FreeScout has upgraded the database. That way an older table layout never limits them. Values encrypted with the destination's old `APP_KEY` (module licenses, bind passwords, private keys) are decrypted and re-encrypted with the new key, so FreeScout can still read them. This needs agent 1.2.1 or newer, and every run logs what it kept:

- `options` rows of SSO modules (aliases matching saml, oauth, sso, ldap, socialite, azure, entra, okta, openid, oidc or adfs), plus any option name starting with `saml`, `oauth`, `sso` or `socialite`. The source's SSO rows are removed first, so the destination ends up exactly as it was.
- The `modules` rows (active flag, license) of those modules.
- Tables whose names start with those words (e.g. `saml_sessions`).
- Top-level folders in `storage/app` named `saml*`, `oauth*`, `sso*` or `socialite*` (certificates and metadata).

To preview what a server would keep, and see SSO-looking settings that would **not** be kept, run on that server:

```bash
sudo /usr/local/sbin/fs-agent sso-keep-preview
```

To keep more, add module aliases or option-name prefixes to `KEEP_MODULES` / `KEEP_OPTIONS` in `/etc/fs-agent.conf` on that server. User accounts are data, so they always come from the source.

## What a restore does on the target

1. Turns maintenance mode on and pauses the scheduler.
2. `fs-agent restore-db` checks the received dump and **saves the target's current database to `/var/backups/fs-agent/`** (the last 3 are kept). It then drops all tables and imports the dump. If the import fails, it puts the old database back automatically.
3. Copies files with `rsync --delete`: all application files, or only `storage/app` and modules in a data-only copy. Never copied: `.env`, `storage/logs`, `storage/framework`, `bootstrap/cache`, JS/CSS builds and the `public/storage` link. The target keeps its own URL and database login.
4. Finalize:
   - Puts the source's `APP_KEY` into `.env` and runs `storage:link`.
   - Runs `migrate --force` and `freescout:after-app-update`, which upgrade the database to the target's FreeScout version.
   - Runs `freescout:module-install` for each module (module migrations and public links).
   - Puts back the kept SSO settings, rebuilds caches and fixes file ownership.
5. Turns maintenance mode off and sets standby or active as requested. It then compares row counts and runs a `/login` health check.

## After a migration

- Users open the target's URL. To keep the old address, point its DNS at the new server, set `APP_URL` in the new server's `.env`, then run `sudo -u www-data php artisan freescout:clear-cache`.
- Re-activate paid module licenses if they're bound to a domain.
- Send a test email to each mailbox and reply to it.
- Disable or delete the old sync job (the migration already paused it).
