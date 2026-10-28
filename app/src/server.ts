import express, { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { one, all, exec, parse, getSetting, setSetting } from './db.js';
import { APP_DIR, AGENT_DIR, BIND, PORT, LOG_DIR, BACKUP_DIR, DATA_DIR, AGENT_VERSION } from './config.js';
import { requireAuth, verifyPassword, hashPassword, createSession, destroySession, setSessionCookie, readCookie, COOKIE,
  loginBlocked, loginFailed, loginOk } from './auth.js';
import { ensureSshKey, publicKey, hostKeyFingerprint, resetHostKey, agentJson } from './remote.js';
import { enqueue, cancelRun, recoverInterrupted, backupStoreUsage, isBusy } from './runner.js';
import { startScheduler, validateSchedule, refreshNextRun, runJob, refreshInstance } from './scheduler.js';

ensureSshKey();
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '100kb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'");
  next();
});

type H = (req: Request, res: Response) => any;
const wrap = (fn: H) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);
const bad = (res: Response, msg: string, code = 400) => res.status(code).json({ error: msg });
const idParam = (req: Request) => Number(req.params.id);
const str = (v: any, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ─── agent installer (public: contains only the manager's PUBLIC key) ───
function agentScript(req: Request): string {
  const b64 = (f: string) => fs.readFileSync(path.join(AGENT_DIR, f)).toString('base64');
  const url = `${req.protocol}://${req.get('host')}`;
  return fs.readFileSync(path.join(AGENT_DIR, 'install-agent.sh'), 'utf8')
    .replaceAll('__MANAGER_PUBKEY__', publicKey())
    .replaceAll('__MANAGER_FROM__', getSetting('agent_from'))
    .replaceAll('__MANAGER_URL__', url)
    .replaceAll('__AGENT_B64__', b64('fs-agent'))
    .replaceAll('__AGENT_SSH_B64__', b64('fs-agent-ssh'));
}
app.get('/agent/install.sh', (req, res) => {
  res.type('text/x-shellscript').setHeader('Content-Disposition', 'attachment; filename="install-agent.sh"');
  res.send(agentScript(req));
});

// ─── auth ───
app.post('/api/login', wrap(async (req, res) => {
  const ip = req.ip ?? '?';
  if (loginBlocked(ip)) return bad(res, 'Too many failed attempts - try again in 15 minutes', 429);
  const u = one('SELECT * FROM users WHERE username = ?', str(req.body?.username, 64));
  if (!u || !verifyPassword(String(req.body?.password ?? ''), u.pass_hash)) {
    loginFailed(ip); await new Promise(r => setTimeout(r, 400));
    return bad(res, 'Wrong username or password', 401);
  }
  loginOk(ip);
  setSessionCookie(req, res, createSession(u.id));
  res.json({ username: u.username });
}));
app.post('/api/logout', (req, res) => {
  const t = readCookie(req, COOKIE); if (t) destroySession(t);
  setSessionCookie(req, res, null); res.json({ ok: true });
});
app.use('/api', requireAuth);
app.get('/api/me', (req, res) => res.json({ username: (req as any).user.username }));
app.post('/api/password', (req, res) => {
  const u = one('SELECT * FROM users WHERE id = ?', (req as any).user.id)!;
  if (!verifyPassword(String(req.body?.current ?? ''), u.pass_hash)) return bad(res, 'Current password is wrong');
  const pw = String(req.body?.password ?? '');
  if (pw.length < 10) return bad(res, 'New password must be at least 10 characters');
  exec('UPDATE users SET pass_hash = ? WHERE id = ?', hashPassword(pw), u.id);
  res.json({ ok: true });
});

// ─── settings ───
app.get('/api/settings', (req, res) => {
  const url = `${req.protocol}://${req.get('host')}`;
  const from = getSetting('agent_from');
  res.json({
    public_key: publicKey(), agent_from: from, agent_version: AGENT_VERSION, manager_url: url, hostname: os.hostname(),
    install_command: `curl -fsSk ${url}/agent/install.sh -o install-agent.sh && sudo bash install-agent.sh`,
  });
});
app.put('/api/settings', (req, res) => {
  const from = str(req.body?.agent_from, 200);
  if (from && !/^[0-9A-Fa-f.:/,]+$/.test(from)) return bad(res, 'Allowed source must be IPs/CIDRs separated by commas');
  setSetting('agent_from', from);
  res.json({ ok: true });
});

// ─── dashboard ───
let usageCache = { at: 0, bytes: 0 };
app.get('/api/dashboard', wrap(async (_req, res) => {
  if (Date.now() - usageCache.at > 20_000 && !isBusy()) usageCache = { at: Date.now(), bytes: await backupStoreUsage() };
  const st = fs.statfsSync(DATA_DIR);
  res.json({
    instances: all('SELECT * FROM instances ORDER BY name').map(instanceOut),
    jobs: all('SELECT * FROM jobs ORDER BY name').map(jobOut),
    runs: all(`SELECT r.*, j.name AS job_name FROM runs r LEFT JOIN jobs j ON j.id = r.job_id ORDER BY r.id DESC LIMIT 12`).map(runOut),
    storage: { backups_bytes: usageCache.bytes, free_bytes: st.bavail * st.bsize, total_bytes: st.blocks * st.bsize },
    snapshots: one(`SELECT COUNT(*) AS n FROM snapshots WHERE status = 'complete'`)!.n,
  });
}));

// ─── instances ───
function instanceOut(r: any) {
  return { ...r, last_info: parse(r.last_info, null), last_stats: parse(r.last_stats, null), host_key: hostKeyFingerprint(r) };
}
function instanceIn(b: any): { name: string; host: string; port: number; ssh_user: string; notes: string } | string {
  const name = str(b?.name, 60), host = str(b?.host, 253), ssh_user = str(b?.ssh_user, 32) || 'fsagent';
  const port = Number(b?.port ?? 22);
  if (!name) return 'Name is required';
  if (!/^[A-Za-z0-9.:-]+$/.test(host)) return 'Host must be a hostname or IP address';
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Port must be 1-65535';
  if (!/^[a-z_][a-z0-9_-]*$/.test(ssh_user)) return 'SSH user is invalid';
  return { name, host, port, ssh_user, notes: str(b?.notes, 1000) };
}
app.get('/api/instances', (_req, res) => res.json(all('SELECT * FROM instances ORDER BY name').map(instanceOut)));
app.post('/api/instances', (req, res) => {
  const v = instanceIn(req.body); if (typeof v === 'string') return bad(res, v);
  const id = exec('INSERT INTO instances(name, host, port, ssh_user, notes) VALUES (?, ?, ?, ?, ?)', v.name, v.host, v.port, v.ssh_user, v.notes).lastInsertRowid;
  res.json(instanceOut(one('SELECT * FROM instances WHERE id = ?', id)));
});
app.put('/api/instances/:id', (req, res) => {
  const v = instanceIn(req.body); if (typeof v === 'string') return bad(res, v);
  exec('UPDATE instances SET name = ?, host = ?, port = ?, ssh_user = ?, notes = ? WHERE id = ?', v.name, v.host, v.port, v.ssh_user, v.notes, idParam(req));
  res.json(instanceOut(one('SELECT * FROM instances WHERE id = ?', idParam(req))));
});
app.delete('/api/instances/:id', (req, res) => {
  if (one(`SELECT id FROM runs WHERE status IN ('queued','running') AND (source_id = ? OR target_id = ?)`, idParam(req), idParam(req)))
    return bad(res, 'This instance has a queued or running job');
  exec('DELETE FROM instances WHERE id = ?', idParam(req));
  res.json({ ok: true });
});
app.post('/api/instances/:id/test', wrap(async (req, res) => {
  const i = one('SELECT * FROM instances WHERE id = ?', idParam(req));
  if (!i) return bad(res, 'Not found', 404);
  const r = await refreshInstance(i as any);
  res.json({ ...r, instance: instanceOut(one('SELECT * FROM instances WHERE id = ?', i.id)) });
}));
app.post('/api/instances/:id/reset-hostkey', (req, res) => {
  const i = one('SELECT * FROM instances WHERE id = ?', idParam(req));
  if (!i) return bad(res, 'Not found', 404);
  resetHostKey(i as any); res.json({ ok: true });
});
app.post('/api/instances/:id/mode', wrap(async (req, res) => {
  const i = one('SELECT * FROM instances WHERE id = ?', idParam(req));
  if (!i) return bad(res, 'Not found', 404);
  const mode = req.body?.mode === 'active' ? 'active' : 'standby';
  if (one(`SELECT id FROM runs WHERE status IN ('queued','running') AND (source_id = ? OR target_id = ?)`, i.id, i.id)) return bad(res, 'A run is using this instance - wait for it to finish');
  await agentJson(i as any, ['mode', mode]);
  const r = await refreshInstance(i as any);
  res.json(r);
}));
app.post('/api/instances/:id/mail-on', (req, res) => {
  const on = one('SELECT id, name FROM instances WHERE id = ?', idParam(req));
  if (!on) return bad(res, 'Not found', 404);
  const offIds = [...new Set((Array.isArray(req.body?.off_ids) ? req.body.off_ids : []).map(Number))].filter(n => Number.isInteger(n) && n !== on.id);
  for (const id of offIds) if (!one('SELECT id FROM instances WHERE id = ?', id)) return bad(res, `Instance #${id} no longer exists`);
  if (one(`SELECT id FROM runs WHERE type = 'switch' AND status IN ('queued','running')`)) return bad(res, 'A mail switch is already queued or running');
  res.json({ run_id: enqueue({ type: 'switch', target_id: on.id, options: { off_ids: offIds, force: req.body?.force === true }, trigger: 'manual' }) });
});
app.post('/api/instances/:id/backup', (req, res) => {
  if (!one('SELECT id FROM instances WHERE id = ?', idParam(req))) return bad(res, 'Not found', 404);
  res.json({ run_id: enqueue({ type: 'backup', source_id: idParam(req), trigger: 'manual' }) });
});

// ─── jobs ───
function jobOut(r: any) {
  const last = one(`SELECT id, status, finished_at, started_at FROM runs WHERE job_id = ? ORDER BY id DESC LIMIT 1`, r.id);
  return { ...r, schedule: parse(r.schedule, { kind: 'manual' }), options: parse(r.options, {}), enabled: !!r.enabled, last_run: last ?? null };
}
function jobIn(b: any): Record<string, any> | string {
  const type = b?.type;
  if (!['backup', 'sync', 'migrate'].includes(type)) return 'Type must be backup, sync or migrate';
  const source_id = Number(b?.source_id), target_id = b?.target_id ? Number(b.target_id) : null;
  if (!one('SELECT id FROM instances WHERE id = ?', source_id)) return 'Choose a source instance';
  if (type !== 'backup') {
    if (!target_id || !one('SELECT id FROM instances WHERE id = ?', target_id)) return 'Choose a target instance';
    if (target_id === source_id) return 'Source and target must be different instances';
  }
  const schedule = validateSchedule(b?.schedule);
  if (type === 'migrate' && schedule.kind !== 'manual') return 'Migrations run manually (use a sync job for a schedule)';
  const retention = Math.min(Math.max(1, Number(b?.retention) || 7), 365);
  const files = ['auto', 'data', 'full'].includes(b?.options?.files) ? b.options.files : 'auto';
  const keep_sso = b?.options?.keep_sso !== false;
  const options = type === 'migrate' ? { activate_target: b?.options?.activate_target !== false, standby_source: b?.options?.standby_source !== false, files, keep_sso }
    : type === 'sync' ? { files, keep_sso } : {};
  return { name: str(b?.name, 80) || `${type} job`, type, source_id, target_id: type === 'backup' ? null : target_id,
    schedule: JSON.stringify(schedule), retention, options: JSON.stringify(options), enabled: b?.enabled === false ? 0 : 1 };
}
app.get('/api/jobs', (_req, res) => res.json(all('SELECT * FROM jobs ORDER BY name').map(jobOut)));
app.post('/api/jobs', (req, res) => {
  const v = jobIn(req.body); if (typeof v === 'string') return bad(res, v);
  const id = Number(exec('INSERT INTO jobs(name, type, source_id, target_id, schedule, retention, options, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    v.name, v.type, v.source_id, v.target_id, v.schedule, v.retention, v.options, v.enabled).lastInsertRowid);
  refreshNextRun(id);
  res.json(jobOut(one('SELECT * FROM jobs WHERE id = ?', id)));
});
app.put('/api/jobs/:id', (req, res) => {
  const v = jobIn(req.body); if (typeof v === 'string') return bad(res, v);
  exec('UPDATE jobs SET name = ?, type = ?, source_id = ?, target_id = ?, schedule = ?, retention = ?, options = ?, enabled = ? WHERE id = ?',
    v.name, v.type, v.source_id, v.target_id, v.schedule, v.retention, v.options, v.enabled, idParam(req));
  refreshNextRun(idParam(req));
  res.json(jobOut(one('SELECT * FROM jobs WHERE id = ?', idParam(req))));
});
app.delete('/api/jobs/:id', (req, res) => { exec('DELETE FROM jobs WHERE id = ?', idParam(req)); res.json({ ok: true }); });
app.post('/api/jobs/:id/run', (req, res) => {
  const j = one('SELECT * FROM jobs WHERE id = ?', idParam(req));
  if (!j) return bad(res, 'Not found', 404);
  if (one(`SELECT id FROM runs WHERE job_id = ? AND status IN ('queued','running')`, j.id)) return bad(res, 'This job is already queued or running');
  res.json({ run_id: runJob(j, 'manual') });
});

// ─── runs ───
function runOut(r: any) {
  const name = (id: number | null) => (id ? (one('SELECT name FROM instances WHERE id = ?', id)?.name ?? `#${id} (deleted)`) : null);
  return { ...r, steps: parse(r.steps, []), result: parse(r.result, {}), options: parse(r.options, {}),
    source_name: name(r.source_id), target_name: name(r.target_id) };
}
app.get('/api/runs', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json(all(`SELECT r.*, j.name AS job_name FROM runs r LEFT JOIN jobs j ON j.id = r.job_id ORDER BY r.id DESC LIMIT ?`, limit).map(runOut));
});
app.get('/api/runs/:id', (req, res) => {
  const r = one('SELECT r.*, j.name AS job_name FROM runs r LEFT JOIN jobs j ON j.id = r.job_id WHERE r.id = ?', idParam(req));
  if (!r) return bad(res, 'Not found', 404);
  res.json(runOut(r));
});
app.get('/api/runs/:id/log', (req, res) => {
  const file = path.join(LOG_DIR, `run-${idParam(req)}.log`);
  const from = Math.max(0, Number(req.query.from) || 0);
  if (!fs.existsSync(file)) return res.json({ text: '', next: 0 });
  const size = fs.statSync(file).size;
  const len = Math.min(size - from, 256 * 1024);
  if (len <= 0) return res.json({ text: '', next: size });
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r'); fs.readSync(fd, buf, 0, len, from); fs.closeSync(fd);
  res.json({ text: buf.toString('utf8'), next: from + len });
});
app.post('/api/runs/:id/cancel', (req, res) => res.json({ ok: cancelRun(idParam(req)) }));

// ─── snapshots ───
app.get('/api/snapshots', (req, res) => {
  const inst = Number(req.query.instance) || null;
  const rows = inst ? all(`SELECT * FROM snapshots WHERE instance_id = ? AND status = 'complete' ORDER BY id DESC`, inst)
    : all(`SELECT * FROM snapshots WHERE status = 'complete' ORDER BY id DESC`);
  res.json(rows.map(r => ({ ...r, stats: parse(r.stats, {}), pinned: !!r.pinned })));
});
const snapOr404 = (req: Request, res: Response) => {
  const s = one(`SELECT * FROM snapshots WHERE id = ? AND status = 'complete'`, idParam(req));
  if (!s) bad(res, 'Snapshot not found', 404);
  return s;
};
app.post('/api/snapshots/:id/pin', (req, res) => {
  const s = snapOr404(req, res); if (!s) return;
  exec('UPDATE snapshots SET pinned = ? WHERE id = ?', req.body?.pinned ? 1 : 0, s.id); res.json({ ok: true });
});
app.delete('/api/snapshots/:id', (req, res) => {
  const s = snapOr404(req, res); if (!s) return;
  if (one(`SELECT id FROM runs WHERE snapshot_id = ? AND status IN ('queued','running')`, s.id)) return bad(res, 'Snapshot is in use by a run');
  const p = path.resolve(s.path);
  if (p.startsWith(path.resolve(BACKUP_DIR) + path.sep)) fs.rmSync(p, { recursive: true, force: true });
  exec('DELETE FROM snapshots WHERE id = ?', s.id); usageCache.at = 0;
  res.json({ ok: true });
});
app.post('/api/snapshots/:id/restore', (req, res) => {
  const s = snapOr404(req, res); if (!s) return;
  const target = Number(req.body?.target_id);
  if (!one('SELECT id FROM instances WHERE id = ?', target)) return bad(res, 'Choose a target instance');
  if (str(req.body?.confirm, 100) !== one('SELECT name FROM instances WHERE id = ?', target)!.name) return bad(res, 'Type the target instance name to confirm');
  res.json({ run_id: enqueue({ type: 'restore', snapshot_id: s.id, target_id: target, options: { mode: req.body?.mode === 'active' ? 'active' : 'standby', files: ['auto', 'data', 'full'].includes(req.body?.files) ? req.body.files : 'auto', keep_sso: req.body?.keep_sso !== false } }) });
});
app.get('/api/snapshots/:id/db.sql.gz', (req, res) => {
  const s = snapOr404(req, res); if (!s) return;
  res.download(path.join(s.path, 'db.sql.gz'), `${s.instance_name.replace(/[^A-Za-z0-9_-]/g, '_')}-${s.id}-db.sql.gz`);
});

// ─── static UI ───
app.use(express.static(path.join(APP_DIR, 'public'), { index: 'index.html', maxAge: '1h' }));
app.get(/^\/(?!api\/|agent\/).*/, (_req, res) => res.sendFile(path.join(APP_DIR, 'public', 'index.html')));

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err?.message ?? 'Internal error' });
});

recoverInterrupted();
startScheduler();
app.listen(PORT, BIND, () => console.log(`FreeScout Sync Manager listening on http://${BIND}:${PORT}`));
