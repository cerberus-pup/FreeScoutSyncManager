import fs from 'node:fs';
import path from 'node:path';
import { one, all, exec, parse, Row } from './db.js';
import { BACKUP_DIR, LOG_DIR, AGENT_VERSION, SSO_STORAGE_DIRS } from './config.js';
import { agent, agentJson, rsyncPull, rsyncPush, runProcess, diskUsage, Instance, RemoteError } from './remote.js';

export type RunType = 'backup' | 'restore' | 'sync' | 'migrate' | 'switch';
type StepStatus = 'pending' | 'running' | 'ok' | 'warn' | 'failed' | 'skipped';
interface Step { key: string; label: string; status: StepStatus; started_at?: string; finished_at?: string; detail?: string }

const BACKUP_STEPS: [string, string][] = [
  ['b.connect', 'Connect to source'],
  ['b.stats', 'Record source counts'],
  ['b.key', 'Read encryption key (APP_KEY)'],
  ['b.db', 'Dump database'],
  ['b.files', 'Copy files (incremental)'],
  ['b.verify', 'Verify backup'],
  ['b.prune', 'Apply retention'],
];
const RESTORE_STEPS: [string, string][] = [
  ['r.connect', 'Connect to target'],
  ['r.preflight', 'Pre-flight checks'],
  ['r.maint', 'Maintenance mode on'],
  ['r.pause', 'Pause target scheduler'],
  ['r.db', 'Restore database (safety dump first)'],
  ['r.files', 'Copy files'],
  ['r.finalize', 'Finalize (APP_KEY, migrations, caches)'],
  ['r.mode', 'Set target mode'],
  ['r.verify', 'Compare row counts'],
  ['r.health', 'Health check'],
];
const MIGRATE_EXTRA: [string, string][] = [['m.source', 'Put source in standby']];
const SWITCH_STEPS: [string, string][] = [
  ['w.off', 'Turn mail off on the other servers'],
  ['w.on', 'Turn mail on'],
  ['w.check', 'Check which servers have mail on'],
];

export function plannedSteps(type: RunType): Step[] {
  const list = type === 'switch' ? SWITCH_STEPS
    : type === 'backup' ? BACKUP_STEPS
    : type === 'restore' ? RESTORE_STEPS
    : type === 'sync' ? [...BACKUP_STEPS, ...RESTORE_STEPS]
    : [...BACKUP_STEPS, ...RESTORE_STEPS, ...MIGRATE_EXTRA];
  return list.map(([key, label]) => ({ key, label, status: 'pending' as StepStatus }));
}

const COUNT_TABLES = ['conversations', 'threads', 'customers', 'emails', 'users', 'mailboxes', 'folders', 'attachments'];
const nowIso = () => new Date().toISOString();
const fmtBytes = (n: number) => n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? (n / 1e3).toFixed(0) + ' KB' : n + ' B';

export function getInstance(id: number | null | undefined): Instance & Row {
  const r = id ? one('SELECT * FROM instances WHERE id = ?', id) : undefined;
  if (!r) throw new Error('Instance no longer exists');
  return r as Instance & Row;
}

class RunCtx {
  steps: Step[];
  result: Record<string, any>;
  abort = new AbortController();
  private logFile: string;
  constructor(public run: Row) {
    this.steps = parse<Step[]>(run.steps, []);
    if (!this.steps.length) this.steps = plannedSteps(run.type);
    this.result = parse(run.result, {});
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    this.logFile = path.join(LOG_DIR, `run-${run.id}.log`);
  }
  log = (msg: string) => {
    const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
    fs.appendFileSync(this.logFile, msg.split('\n').map(l => `[${t}] ${l}`).join('\n') + '\n', { mode: 0o600 });
  };
  save() { exec('UPDATE runs SET steps = ?, result = ? WHERE id = ?', JSON.stringify(this.steps), JSON.stringify(this.result), this.run.id); }
  get(key: string) { return this.steps.find(s => s.key === key)!; }
  skip(key: string, detail: string) { const s = this.get(key); if (s) { s.status = 'skipped'; s.detail = detail; this.save(); } }
  warn(key: string, detail: string) { const s = this.get(key); s.status = 'warn'; s.detail = detail; }
  async step<T>(key: string, fn: (s: Step) => Promise<T>): Promise<T> {
    const s = this.get(key);
    if (this.abort.signal.aborted) throw new RemoteError('Cancelled');
    s.status = 'running'; s.started_at = nowIso(); this.save();
    this.log(`── ${s.label}`);
    try {
      const out = await fn(s);
      if (s.status === 'running') s.status = 'ok';
      if (s.detail) this.log(`   ${s.detail}`);
      return out;
    } catch (e: any) {
      s.status = 'failed'; s.detail = e.message; this.log(`   FAILED: ${e.message}`);
      throw e;
    } finally {
      s.finished_at = nowIso(); this.save();
    }
  }
  opts() { return { signal: this.abort.signal, log: (l: string) => this.log(`   ${l}`) }; }
}

// ───────────────────────────── backup ─────────────────────────────
async function doBackup(ctx: RunCtx, src: Instance & Row, jobId: number | null, retention: number): Promise<Row> {
  const o = ctx.opts();
  const info = await ctx.step('b.connect', async s => {
    const info = await agentJson(src, ['info'], o);
    exec('UPDATE instances SET last_info = ?, last_seen_at = ?, last_error = NULL WHERE id = ?', JSON.stringify(info), nowIso(), src.id);
    s.detail = `${info.hostname}, FreeScout ${info.freescout_version}, PHP ${info.php_version}`;
    if (info.agent_version !== AGENT_VERSION) ctx.warn('b.connect', `${s.detail}, agent ${info.agent_version} is outdated (current ${AGENT_VERSION}) - re-run the agent install command`);
    return info;
  });
  const stats = await ctx.step('b.stats', async s => {
    const st = await agentJson(src, ['stats'], o);
    exec('UPDATE instances SET last_stats = ? WHERE id = ?', JSON.stringify(st), src.id);
    s.detail = `${st.conversations} conversations, ${st.threads} threads, ${st.customers} customers, ${st.attachments} attachments`;
    return st;
  });

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dir = path.join(BACKUP_DIR, String(src.id), stamp);
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true, mode: 0o700 });
  const prev = one(`SELECT path FROM snapshots WHERE instance_id = ? AND status = 'complete' ORDER BY id DESC LIMIT 1`, src.id);
  // Files kept from a failed/cancelled run are reused, so a retry doesn't copy everything again
  const resumeDir = path.join(BACKUP_DIR, String(src.id), '.resume-files');
  const linkDests = [prev ? path.join(prev.path, 'files') : null, fs.existsSync(resumeDir) ? resumeDir : null].filter(Boolean) as string[];
  const snapId = Number(exec(`INSERT INTO snapshots(instance_id, instance_name, job_id, run_id, path, status, freescout_version, app_url, stats)
      VALUES (?, ?, ?, ?, ?, 'partial', ?, ?, ?)`, src.id, src.name, jobId, ctx.run.id, dir, info.freescout_version, info.app_url, JSON.stringify(stats)).lastInsertRowid);
  exec('UPDATE runs SET snapshot_id = ? WHERE id = ?', snapId, ctx.run.id);
  ctx.result.snapshot_id = snapId;
  ctx.result.source_stats = stats;
  ctx.result.source_info = info;

  try {
    await ctx.step('b.key', async s => {
      const key = (await agent(src, ['get-appkey'], o)).trim();
      if (!/^base64:/.test(key)) throw new Error('APP_KEY looks invalid');
      fs.writeFileSync(path.join(dir, 'appkey'), key + '\n', { mode: 0o600 });
      s.detail = 'stored (readable by the manager service only)';
    });
    const dbFile = path.join(dir, 'db.sql.gz');
    await ctx.step('b.db', async s => {
      await agent(src, ['dump-db'], { ...o, stdoutFile: dbFile });
      const size = fs.statSync(dbFile).size;
      const t = await runProcess('gzip', ['-t', dbFile]);
      if (t.code !== 0) throw new Error('dump is not valid gzip (connection dropped?)');
      if (size < 200) throw new Error('dump is suspiciously small');
      s.detail = `${fmtBytes(size)} compressed`;
    });
    const fstats = await ctx.step('b.files', async s => {
      if (linkDests.length) ctx.log(`   reusing unchanged files from: ${linkDests.map(d => path.relative(BACKUP_DIR, d)).join(', ')}`);
      const st = await rsyncPull(src, info.install_dir, path.join(dir, 'files'), linkDests, o);
      s.detail = `${st.files} changed files copied (${fmtBytes(st.transferredBytes)}) of ${fmtBytes(st.totalBytes)}${linkDests.length ? ', unchanged files hard-linked (no extra disk space)' : ''}`;
      return st;
    });
    await ctx.step('b.verify', async s => {
      // Read the WHOLE dump: count tables and require the "-- Dump completed" line that
      // mariadb-dump/mysqldump writes last (proves the dump was not cut off part-way).
      // (Tables are dumped alphabetically and activity_logs alone can be hundreds of MB.)
      const scan = await runProcess('sh', ['-c', `gunzip -c "$1" | LC_ALL=C awk '/^CREATE TABLE /{n++} /^-- Dump completed/{d=1} END{print n+0, d+0}'`, 'sh', dbFile], { signal: ctx.abort.signal });
      const [tables, completed] = scan.stdout.trim().split(/\s+/).map(Number);
      if (scan.code !== 0) throw new Error(`could not read the dump back (exit ${scan.code}): ${scan.stderr.trim().slice(-200)}`);
      if (!completed) throw new Error('database dump is incomplete: its final "Dump completed" line is missing (the dump was cut off)');
      if (tables < 10) throw new Error(`database dump has only ${tables} tables - expected a full FreeScout database`);
      for (const f of ['artisan', 'config/app.php', 'composer.json']) {
        if (!fs.existsSync(path.join(dir, 'files', f))) throw new Error(`file copy is missing ${f}`);
      }
      const meta = { instance: src.name, created_at: nowIso(), freescout_version: info.freescout_version, app_url: info.app_url,
        install_dir: info.install_dir, php_version: info.php_version, stats, rsync: fstats };
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
      const dbBytes = fs.statSync(dbFile).size;
      exec(`UPDATE snapshots SET status = 'complete', db_bytes = ?, files_bytes = ? WHERE id = ?`, dbBytes, fstats.totalBytes, snapId);
      s.detail = `database dump complete (${tables} tables); application files present`;
      fs.rmSync(resumeDir, { recursive: true, force: true });
    });
  } catch (e) {
    // keep the copied files for the next attempt; discard the rest of the failed snapshot
    const files = path.join(dir, 'files');
    try {
      if (fs.existsSync(files) && fs.readdirSync(files).length) {
        fs.rmSync(resumeDir, { recursive: true, force: true });
        fs.renameSync(files, resumeDir);
        ctx.log('   files copied so far are kept and will be reused by the next backup');
      }
    } catch { /* best effort */ }
    fs.rmSync(dir, { recursive: true, force: true });
    exec('DELETE FROM snapshots WHERE id = ?', snapId);
    delete ctx.result.snapshot_id;
    throw e;
  }

  await ctx.step('b.prune', async s => {
    if (!jobId) { s.status = 'skipped'; s.detail = 'manual backup - kept until you delete it'; return; }
    const keep = Math.max(1, retention);
    const old = all(`SELECT id, path FROM snapshots WHERE job_id = ? AND status = 'complete' AND pinned = 0 ORDER BY id DESC LIMIT -1 OFFSET ?`, jobId, keep);
    for (const r of old) { fs.rmSync(r.path, { recursive: true, force: true }); exec('DELETE FROM snapshots WHERE id = ?', r.id); }
    s.detail = old.length ? `removed ${old.length} old snapshot(s), keeping ${keep}` : `nothing to remove (keeping ${keep})`;
  });
  return one('SELECT * FROM snapshots WHERE id = ?', snapId)!;
}

// ───────────────────────────── restore ─────────────────────────────
/** Compare dotted versions numerically: <0 if a<b, 0 if equal, >0 if a>b. */
export function cmpVersion(a?: string | null, b?: string | null): number {
  const pa = String(a ?? '').split('.').map(n => parseInt(n, 10) || 0), pb = String(b ?? '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
}
export type FilesOption = 'auto' | 'data' | 'full';
const MIN_AGENT = '1.1.0';
const MIN_AGENT_KEEP_SSO = '1.2.1';

/**
 * full = copy all application files (exact clone, target ends up on the source's FreeScout version)
 * data = copy only data (database, storage/app, modules); target keeps its own, newer FreeScout code
 *        and its database is upgraded with FreeScout's own migrations.
 */
function decideScope(opt: FilesOption, srcV: string, tgtV: string): { scope: 'full' | 'data'; why: string } {
  const c = cmpVersion(srcV, tgtV);
  if (opt === 'full') return { scope: 'full', why: c === 0 ? `exact copy (both FreeScout ${srcV})` : `exact clone requested: target's FreeScout ${tgtV} is replaced by the source's ${srcV}` };
  if (c > 0) throw new Error(`Target runs FreeScout ${tgtV}, which is OLDER than the source's ${srcV}. A database can only be moved to the same or a newer FreeScout. Update the target first (Manage » System » Update, or tools/update.sh), or set the job to "Copy everything" to clone the source's version onto it.`);
  if (opt === 'data' || c < 0) return { scope: 'data', why: c < 0
    ? `data only: target keeps FreeScout ${tgtV}; the ${srcV} database is upgraded to ${tgtV} with FreeScout's own migrations`
    : `data only (target keeps its application code, FreeScout ${tgtV})` };
  return { scope: 'full', why: `exact copy (both FreeScout ${srcV})` };
}

function localModules(modulesDir: string): { dir: string; alias: string; version: string }[] {
  if (!fs.existsSync(modulesDir)) return [];
  const out: { dir: string; alias: string; version: string }[] = [];
  for (const d of fs.readdirSync(modulesDir)) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(modulesDir, d, 'module.json'), 'utf8'));
      out.push({ dir: d, alias: String(j.alias ?? ''), version: String(j.version ?? '') });
    } catch { /* not a module */ }
  }
  return out;
}

async function doRestore(ctx: RunCtx, snap: Row, tgt: Instance & Row, finalMode: 'active' | 'standby', filesOpt: FilesOption = 'auto', keepSso = true) {
  const o = ctx.opts();
  const dir = snap.path as string;
  for (const f of ['db.sql.gz', 'appkey', 'files/artisan']) {
    if (!fs.existsSync(path.join(dir, f))) throw new Error(`snapshot #${snap.id} is incomplete (missing ${f})`);
  }
  const info = await ctx.step('r.connect', async s => {
    const info = await agentJson(tgt, ['info'], o);
    exec('UPDATE instances SET last_info = ?, last_seen_at = ?, last_error = NULL WHERE id = ?', JSON.stringify(info), nowIso(), tgt.id);
    s.detail = `${info.hostname}, ${info.app_url}, FreeScout ${info.freescout_version} → ${snap.freescout_version}`;
    return info;
  });
  ctx.result.target_info_before = info;
  await ctx.step('r.preflight', async s => {
    const notes: string[] = [];
    const dbBytes = fs.statSync(path.join(dir, 'db.sql.gz')).size;
    const need = dbBytes * 12 + (snap.files_bytes ?? 0);
    if (info.disk_free_bytes && info.disk_free_bytes < need) throw new Error(`target has ${fmtBytes(info.disk_free_bytes)} free; about ${fmtBytes(need)} needed`);
    if (cmpVersion(info.agent_version, MIN_AGENT) < 0) throw new Error(`the agent on ${tgt.name} is version ${info.agent_version}; ${MIN_AGENT} or newer is needed for restores. Re-run the agent install command on that server (Settings page), then run again.`);
    else if (keepSso && cmpVersion(info.agent_version, MIN_AGENT_KEEP_SSO) < 0) throw new Error(`the agent on ${tgt.name} is version ${info.agent_version}; keeping its SSO settings needs ${MIN_AGENT_KEEP_SSO} or newer. Re-run the agent install command on that server (Settings page), then run again. Nothing was changed.`);
    else if (info.agent_version !== AGENT_VERSION) notes.push(`target agent ${info.agent_version} is outdated`);
    ctx.result.keep_sso = keepSso;
    if (!keepSso) notes.push(`the target's SSO settings WILL be replaced by the source's (keep-SSO is off for this job)`);
    const decision = decideScope(filesOpt, snap.freescout_version, info.freescout_version);
    ctx.result.file_scope = decision.scope;
    ctx.result.versions = { source: snap.freescout_version, target_before: info.freescout_version };
    ctx.result.db_servers = { source: ctx.result.source_info?.db_server ?? null, target: info.db_server ?? null };
    if (!info.scheduler_found) notes.push('no FreeScout cron entry found on target - mail will not be fetched there');
    if (ctx.run.type === 'sync' && !info.standby) {
      const ts = await agentJson(tgt, ['stats'], o).catch(() => ({} as any));
      if ((ts.conversations ?? 0) > 0) throw new Error(`${tgt.name} is ACTIVE (it fetches and sends mail) and has ${ts.conversations} conversations - a sync would overwrite them. Put it in standby first (Instances page) if it really is a spare.`);
    }
    if (info.app_url === snap.app_url && tgt.id !== snap.instance_id) notes.push(`target uses the same APP_URL as the source (${info.app_url})`);
    s.detail = `${decision.why}; disk OK (${fmtBytes(info.disk_free_bytes)} free)` + (notes.length ? '; ' + notes.join('; ') : '');
    if (notes.length) s.status = 'warn';
  });

  let dbTouched = false;
  try {
    await ctx.step('r.maint', async s => { await agentJson(tgt, ['maintenance', 'on'], o); s.detail = 'users see the maintenance page during the restore'; });
    await ctx.step('r.pause', async s => { await agentJson(tgt, ['mode', 'standby'], o); s.detail = 'scheduler and queue workers stopped (no mail fetched or sent)'; });
    await ctx.step('r.db', async s => {
      dbTouched = true;
      const r = await agentJson(tgt, keepSso ? ['restore-db', '--keep-sso'] : ['restore-db'], { ...o, stdinFile: path.join(dir, 'db.sql.gz') });
      ctx.result.target_safety_dump = r.safety_dump;
      if (keepSso) ctx.result.kept_sso = { options: Number(r.kept_options) || 0, encrypted: Number(r.kept_encrypted) || 0, modules: String(r.kept_modules ?? ''), tables: String(r.kept_tables ?? ''), reapplied: false };
      s.detail = `imported; previous target DB saved on the target at ${r.safety_dump}`
        + (keepSso ? `; target's own SSO setup saved (${r.kept_options} settings, ${r.kept_encrypted} encrypted values${r.kept_modules ? `, module rows: ${r.kept_modules}` : ''}${r.kept_tables ? `, tables: ${r.kept_tables}` : ''}) - put back after the database upgrade` : '');
      if (keepSso && Number(r.kept_options) === 0) ctx.result.notes = [...(ctx.result.notes ?? []),
        `${tgt.name} had no SSO settings stored${r.kept_modules ? ` (only the license rows of ${r.kept_modules})` : ''}, so after this run SSO on ${tgt.name} is unconfigured (the source's SSO settings were not copied). If SSO is already set up there, run "sudo /usr/local/sbin/fs-agent sso-keep-preview" on it to see which settings were not recognized.`];
    });
    await ctx.step('r.files', async s => {
      if (ctx.result.file_scope === 'full') {
        const st = await rsyncPush(tgt, path.join(dir, 'files'), info.install_dir, o, keepSso ? SSO_STORAGE_DIRS.map(p => `/storage/app/${p}`) : []);
        s.detail = `${st.files} files updated (${fmtBytes(st.transferredBytes)}); .env, logs and caches on the target kept`;
        return;
      }
      // data only: attachments/uploads, then modules (never replacing a newer module on the target)
      const st = await rsyncPush(tgt, path.join(dir, 'files', 'storage', 'app'), path.join(info.install_dir, 'storage', 'app'), o, keepSso ? SSO_STORAGE_DIRS.map(p => `/${p}`) : []);
      const srcMods = localModules(path.join(dir, 'files', 'Modules'));
      const tgtMods = await agentJson<{ dir: string; version: string }[]>(tgt, ['modules'], o);
      const copied: string[] = [], kept: string[] = [];
      for (const m of srcMods) {
        const t = tgtMods.find(x => x.dir === m.dir);
        if (t && cmpVersion(t.version, m.version) >= 0) { kept.push(`${m.dir} ${t.version}`); continue; }
        await rsyncPush(tgt, path.join(dir, 'files', 'Modules', m.dir), path.join(info.install_dir, 'Modules', m.dir), o);
        copied.push(`${m.dir} ${m.version}`);
      }
      ctx.result.modules = { copied, kept_newer_on_target: kept };
      s.detail = `attachments and uploads: ${st.files} files updated (${fmtBytes(st.transferredBytes)}); `
        + `modules copied: ${copied.length ? copied.join(', ') : 'none'}`
        + (kept.length ? `; kept the target's same-or-newer: ${kept.join(', ')}` : '')
        + `; target's FreeScout code and .env untouched`;
    });
    await ctx.step('r.finalize', async s => {
      const r = await agentJson(tgt, ['finalize'], { ...o, stdinFile: path.join(dir, 'appkey') });
      ctx.result.versions = { ...(ctx.result.versions ?? {}), target_after: r.freescout_version };
      if (ctx.result.kept_sso) ctx.result.kept_sso.reapplied = r.sso_reapplied === true;
      if (keepSso && r.sso_reapplied !== true) throw new Error('the target\'s saved SSO settings were not re-applied');
      s.detail = `APP_KEY applied, database migrated to FreeScout ${r.freescout_version}, module links and caches rebuilt`
        + (keepSso ? `; target's SSO setup put back (${r.sso_options} settings, encrypted values re-encrypted for the new APP_KEY)` : '');
    });
    await ctx.step('r.mode', async s => {
      await agentJson(tgt, ['maintenance', 'off'], o);
      await agentJson(tgt, ['mode', finalMode], o);
      ctx.result.target_mode = finalMode;
      s.detail = finalMode === 'standby'
        ? 'STANDBY - site is up, but it does not fetch or send mail (prevents duplicates)'
        : 'ACTIVE - scheduler on: this instance now fetches and sends mail';
    });
  } catch (e) {
    if (!dbTouched) {
      ctx.log('   rolling back: maintenance off, original mode restored');
      await agent(tgt, ['maintenance', 'off'], o).catch(() => {});
      if (!info.standby) await agent(tgt, ['mode', 'active'], o).catch(() => {});
    } else {
      ctx.result.notes = [...(ctx.result.notes ?? []),
        `Target was left in maintenance mode because the restore stopped part-way. Re-run the job, or roll back the database from ${ctx.result.target_safety_dump ?? 'the safety dump on the target'}.`];
    }
    throw e;
  }

  await ctx.step('r.verify', async s => {
    const tStats = await agentJson(tgt, ['stats'], o);
    exec('UPDATE instances SET last_stats = ? WHERE id = ?', JSON.stringify(tStats), tgt.id);
    const sStats = parse<Record<string, any>>(snap.stats, {});
    const rows = COUNT_TABLES.map(t => ({ table: t, source: sStats[t] ?? null, target: tStats[t] ?? null,
      status: sStats[t] === tStats[t] ? 'match' : (tStats[t] ?? 0) > (sStats[t] ?? 0) ? 'more' : 'less' }));
    ctx.result.comparison = rows;
    ctx.result.target_stats = tStats;
    const less = rows.filter(r => r.status === 'less');
    const more = rows.filter(r => r.status === 'more');
    if (less.length) { ctx.warn('r.verify', `target has FEWER rows in: ${less.map(r => `${r.table} (${r.target}/${r.source})`).join(', ')}`); }
    else s.detail = more.length
      ? `all data present; target has extra rows in ${more.map(r => r.table).join(', ')} (mail that arrived while the backup ran)`
      : `all ${rows.length} tables match exactly`;
  });
  await ctx.step('r.health', async s => {
    const h = await agentJson(tgt, ['health'], o);
    ctx.result.health = h;
    if (!h.ok) ctx.warn('r.health', `${h.url} returned HTTP ${h.http_code}`);
    else s.detail = `${h.url} → HTTP ${h.http_code}`;
    const after = await agentJson(tgt, ['info'], o);
    exec('UPDATE instances SET last_info = ?, last_seen_at = ? WHERE id = ?', JSON.stringify(after), nowIso(), tgt.id);
  });
}

// ───────────────────────────── queue ─────────────────────────────
let current: RunCtx | null = null;
let kicking = false;

export function enqueue(r: { type: RunType; job_id?: number | null; source_id?: number | null; target_id?: number | null;
  snapshot_id?: number | null; options?: Record<string, any>; trigger?: string }): number {
  const id = Number(exec(`INSERT INTO runs(job_id, type, source_id, target_id, snapshot_id, trigger, options, steps)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, r.job_id ?? null, r.type, r.source_id ?? null, r.target_id ?? null, r.snapshot_id ?? null,
    r.trigger ?? 'manual', JSON.stringify(r.options ?? {}), JSON.stringify(plannedSteps(r.type))).lastInsertRowid);
  setImmediate(kick);
  return id;
}

export function cancelRun(id: number): boolean {
  const r = one('SELECT status FROM runs WHERE id = ?', id);
  if (!r) return false;
  if (r.status === 'queued') { exec(`UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ?`, nowIso(), id); return true; }
  if (r.status === 'running' && current?.run.id === id) { current.abort.abort(); return true; }
  return false;
}
export const isBusy = () => current !== null;

export function recoverInterrupted() {
  exec(`UPDATE runs SET status = 'failed', error = 'Manager restarted while this run was in progress', finished_at = ? WHERE status = 'running'`, nowIso());
  for (const p of all(`SELECT id, path FROM snapshots WHERE status = 'partial'`)) {
    fs.rmSync(p.path, { recursive: true, force: true });
    exec('DELETE FROM snapshots WHERE id = ?', p.id);
  }
  setImmediate(kick);
}

async function kick() {
  if (current || kicking) return;
  kicking = true;
  const run = one(`SELECT * FROM runs WHERE status = 'queued' ORDER BY id LIMIT 1`);
  kicking = false;
  if (!run) return;
  exec(`UPDATE runs SET status = 'running', started_at = ? WHERE id = ?`, nowIso(), run.id);
  const ctx = current = new RunCtx({ ...run, status: 'running' });
  let status = 'success', error: string | null = null;
  try {
    await execute(ctx);
    if (ctx.steps.some(s => s.status === 'warn')) status = 'warning';
  } catch (e: any) {
    status = ctx.abort.signal.aborted ? 'cancelled' : 'failed';
    error = e.message;
  } finally {
    for (const s of ctx.steps) if (s.status === 'pending') s.status = 'skipped';
    ctx.save();
    ctx.log(`══ ${status.toUpperCase()}${error ? ': ' + error : ''}`);
    exec('UPDATE runs SET status = ?, error = ?, finished_at = ? WHERE id = ?', status, error, nowIso(), run.id);
    current = null;
    setImmediate(kick);
  }
}

// ───────────────────────────── mail switch ─────────────────────────────
/** Turn mail (FreeScout's scheduler: fetching + sending) on for one server, after turning it off on others. */
async function doSwitch(ctx: RunCtx, on: Instance & Row, offIds: number[], force: boolean) {
  const o = ctx.opts();
  const offs = offIds.map(id => getInstance(id));
  const saveInfo = (i: Row, info: any) => exec('UPDATE instances SET last_info = ?, last_seen_at = ?, last_error = NULL WHERE id = ?', JSON.stringify(info), nowIso(), i.id);
  ctx.result.mail = { on: on.name, turned_off: [] as string[], unreachable: [] as string[], active_now: [] as string[] };

  const wasOn: (Instance & Row)[] = [];
  await ctx.step('w.off', async s => {
    // the server getting mail must be reachable and usable BEFORE anything else is turned off
    const target = await agentJson(on, ['info'], { ...o, timeoutMs: 60_000 }).catch((e: any) => { throw new Error(`could not reach ${on.name}: ${e.message}. Nothing was changed.`); });
    saveInfo(on, target);
    if (target.maintenance) throw new Error(`${on.name} is in maintenance mode (a restore may have stopped part-way) - finish or re-run that restore first. Nothing was changed.`);
    if (!offs.length) { s.status = 'skipped'; s.detail = 'no other servers chosen'; return; }
    // 1) check every server first - change nothing unless all can be reached (or "anyway" was ticked)
    const reachable: (Instance & Row)[] = [];
    for (const x of offs) {
      try {
        const info = await agentJson(x, ['info'], { ...o, timeoutMs: 60_000 });
        saveInfo(x, info); reachable.push(x);
        if (!info.standby) wasOn.push(x);
      } catch (e: any) {
        exec('UPDATE instances SET last_error = ? WHERE id = ?', e.message, x.id);
        ctx.result.mail.unreachable.push(`${x.name}: ${e.message}`);
      }
    }
    if (ctx.result.mail.unreachable.length && !force) {
      throw new Error(`could not reach ${ctx.result.mail.unreachable.join('; ')}. Nothing was changed on any server. Fix the connection and try again, or tick "turn mail on anyway" if that server is down.`);
    }
    // 2) turn mail off on the reachable ones
    for (const x of reachable) {
      await agentJson(x, ['mode', 'standby'], { ...o, timeoutMs: 90_000 });
      const info = await agentJson(x, ['info'], { ...o, timeoutMs: 60_000 });
      saveInfo(x, info);
      if (!info.standby) throw new Error(`mail is still on for ${x.name} after the change`);
      ctx.result.mail.turned_off.push(x.name);
    }
    const offText = `mail off on: ${ctx.result.mail.turned_off.join(', ') || 'none'}`;
    if (ctx.result.mail.unreachable.length) {
      ctx.warn('w.off', `${offText}; COULD NOT REACH ${ctx.result.mail.unreachable.join('; ')}. Continuing because "turn mail on anyway" was ticked - turn mail off there as soon as it is back, or it will fetch mail too.`);
    } else s.detail = offText;
  });

  try {
    await ctx.step('w.on', async s => {
      const before = await agentJson(on, ['info'], o);
      if (before.maintenance) throw new Error(`${on.name} is in maintenance mode (a restore may have stopped part-way) - finish or re-run that restore first`);
      await agentJson(on, ['mode', 'active'], o);
      const after = await agentJson(on, ['info'], o);
      saveInfo(on, after);
      if (after.standby) throw new Error('mail is still off after the change');
      s.detail = `${on.name} now fetches and sends mail`;
      if (!after.scheduler_found) ctx.warn('w.on', `${s.detail} - but no cron entry runs its scheduler, so nothing will actually be fetched. Add the schedule:run cron job on that server.`);
    });
  } catch (e) {
    // don't leave every server with mail off: switch back the ones that had it on
    const back: string[] = [];
    for (const x of wasOn) {
      try { await agentJson(x, ['mode', 'active'], o); saveInfo(x, await agentJson(x, ['info'], o)); back.push(x.name); } catch { /* reported below */ }
    }
    ctx.result.notes = [...(ctx.result.notes ?? []), back.length
      ? `Turning mail on for ${on.name} failed, so mail was switched back on for ${back.join(', ')} (as before).`
      : `Turning mail on for ${on.name} failed and no server had mail on before - check the Instances page.`];
    throw e;
  }

  await ctx.step('w.check', async s => {
    const unknown: string[] = [];
    for (const i of all('SELECT * FROM instances ORDER BY name')) {
      try {
        const info = await agentJson(i as any, ['info'], { ...o, timeoutMs: 30_000 });
        saveInfo(i, info);
        if (!info.standby) ctx.result.mail.active_now.push(i.name);
      } catch { unknown.push(i.name); }
    }
    s.detail = `mail is on for: ${ctx.result.mail.active_now.join(', ') || 'no server'}` + (unknown.length ? `; could not check: ${unknown.join(', ')}` : '');
    if (ctx.result.mail.active_now.length > 1) ctx.warn('w.check', `${s.detail}. More than one server has mail on - fine only if they use different mailboxes.`);
  });
}

async function execute(ctx: RunCtx) {
  const run = ctx.run;
  const options = parse<Record<string, any>>(run.options, {});
  const job = run.job_id ? one('SELECT * FROM jobs WHERE id = ?', run.job_id) : undefined;
  const retention = Number(job?.retention ?? 7);
  ctx.log(`Run #${run.id}: ${run.type}${job ? ` (job "${job.name}")` : ''}, trigger: ${run.trigger}`);

  if (run.type === 'switch') {
    await doSwitch(ctx, getInstance(run.target_id), (options.off_ids ?? []).map(Number), options.force === true);
    return;
  }
  if (run.type === 'backup') {
    await doBackup(ctx, getInstance(run.source_id), run.job_id ?? null, retention);
    return;
  }
  if (run.type === 'restore') {
    const snap = one(`SELECT * FROM snapshots WHERE id = ? AND status = 'complete'`, run.snapshot_id);
    if (!snap) throw new Error('Snapshot not found');
    ctx.result.snapshot_id = snap.id;
    await doRestore(ctx, snap, getInstance(run.target_id), options.mode === 'active' ? 'active' : 'standby', options.files ?? 'auto', options.keep_sso !== false);
    return;
  }
  // sync & migrate: fresh backup of the source, then restore it onto the target
  const src = getInstance(run.source_id), tgt = getInstance(run.target_id);
  if (src.id === tgt.id) throw new Error('Source and target are the same instance');
  const snap = await doBackup(ctx, src, run.job_id ?? null, retention);
  if (run.type === 'sync') {
    await doRestore(ctx, snap, tgt, 'standby', options.files ?? 'auto', options.keep_sso !== false);
    return;
  }
  await doRestore(ctx, snap, tgt, options.activate_target === false ? 'standby' : 'active', options.files ?? 'auto', options.keep_sso !== false);
  if (options.standby_source === false) ctx.skip('m.source', 'not requested - source keeps fetching mail');
  else await ctx.step('m.source', async s => {
    await agentJson(src, ['mode', 'standby'], ctx.opts());
    const after = await agentJson(src, ['info'], ctx.opts());
    exec('UPDATE instances SET last_info = ?, last_seen_at = ? WHERE id = ?', JSON.stringify(after), nowIso(), src.id);
    s.detail = 'source scheduler stopped so only the new server fetches mail';
  });
  if (options.activate_target !== false) {
    const conflicting = all(`SELECT id, name FROM jobs WHERE type = 'sync' AND target_id = ? AND enabled = 1`, tgt.id);
    for (const j of conflicting) exec('UPDATE jobs SET enabled = 0, next_run_at = NULL WHERE id = ?', j.id);
    if (conflicting.length) ctx.result.notes = [...(ctx.result.notes ?? []),
      `Paused sync job(s) ${conflicting.map(j => `"${j.name}"`).join(', ')}: they would have overwritten ${tgt.name}, which is now the active server. Create a new sync job from ${tgt.name} to a spare if you want a standby copy.`];
  }
  ctx.result.checklist = [
    `Users should now open ${ctx.result.target_info_before?.app_url ?? 'the new server'}. To keep the old address (${ctx.result.source_info?.app_url ?? 'old URL'}) instead, point its DNS at the new server and set APP_URL in the new server's .env to it`,
    'Re-activate paid module licenses on the new domain (Manage » Modules)',
    'Send a test email to each mailbox and confirm it shows up on the new server',
    'Check Manage » System » Status on the new server',
    options.standby_source === false ? 'Put the old server in standby once you have cut over' : 'Old server is in standby - decommission it when you are satisfied',
  ];
}

export async function backupStoreUsage(): Promise<number> {
  return fs.existsSync(BACKUP_DIR) ? diskUsage(BACKUP_DIR) : 0;
}
