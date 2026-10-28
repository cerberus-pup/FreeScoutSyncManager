import { all, exec, one, parse } from './db.js';
import { enqueue, RunType } from './runner.js';
import { agentJson, Instance } from './remote.js';

export interface Schedule { kind: 'manual' | 'hourly' | 'daily' | 'weekly'; every?: number; time?: string; weekday?: number; minute?: number }

/** Next run time (server local time zone) strictly after `from`, or null for manual jobs. */
export function computeNext(s: Schedule, from = new Date()): Date | null {
  if (s.kind === 'manual') return null;
  const [hh, mm] = (s.time ?? '02:00').split(':').map(Number);
  const d = new Date(from);
  d.setSeconds(0, 0);
  if (s.kind === 'hourly') {
    const every = Math.min(Math.max(1, Math.floor(s.every ?? 1)), 24);
    d.setMinutes(s.minute ?? 0);
    for (let i = 0; i < 49; i++) {
      if (d > from && d.getHours() % every === 0) return d;
      d.setHours(d.getHours() + 1);
    }
    return d;
  }
  d.setHours(hh || 0, mm || 0, 0, 0);
  if (s.kind === 'daily') {
    if (d <= from) d.setDate(d.getDate() + 1);
    return d;
  }
  const wd = Math.min(Math.max(0, s.weekday ?? 0), 6);
  let add = (wd - d.getDay() + 7) % 7;
  if (add === 0 && d <= from) add = 7;
  d.setDate(d.getDate() + add);
  return d;
}

export function validateSchedule(s: any): Schedule {
  const kind = ['manual', 'hourly', 'daily', 'weekly'].includes(s?.kind) ? s.kind : 'manual';
  const out: Schedule = { kind };
  if (kind === 'hourly') { out.every = Math.min(Math.max(1, Number(s.every) || 1), 24); out.minute = Math.min(Math.max(0, Number(s.minute) || 0), 59); }
  if (kind === 'daily' || kind === 'weekly') out.time = /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time) ? s.time : '02:00';
  if (kind === 'weekly') out.weekday = Math.min(Math.max(0, Number(s.weekday) || 0), 6);
  return out;
}

export function refreshNextRun(jobId: number) {
  const j = one('SELECT schedule, enabled FROM jobs WHERE id = ?', jobId);
  if (!j) return;
  const next = j.enabled ? computeNext(parse<Schedule>(j.schedule, { kind: 'manual' })) : null;
  exec('UPDATE jobs SET next_run_at = ? WHERE id = ?', next ? next.toISOString() : null, jobId);
}

export function runJob(job: Record<string, any>, trigger: string): number {
  return enqueue({ type: job.type as RunType, job_id: job.id, source_id: job.source_id, target_id: job.target_id,
    options: parse(job.options, {}), trigger });
}

function tick() {
  const now = new Date().toISOString();
  for (const job of all(`SELECT * FROM jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`, now)) {
    const active = one(`SELECT id FROM runs WHERE job_id = ? AND status IN ('queued','running')`, job.id);
    if (!active) runJob(job, 'schedule');
    refreshNextRun(job.id as number);
  }
}

/** Refresh each instance's info/stats so the dashboard shows current state. */
export async function refreshInstance(i: Instance) {
  try {
    const info = await agentJson(i, ['info'], { timeoutMs: 60_000 });
    const stats = await agentJson(i, ['stats'], { timeoutMs: 60_000 });
    exec('UPDATE instances SET last_info = ?, last_stats = ?, last_seen_at = ?, last_error = NULL WHERE id = ?',
      JSON.stringify(info), JSON.stringify(stats), new Date().toISOString(), i.id);
    return { ok: true, info, stats };
  } catch (e: any) {
    exec('UPDATE instances SET last_error = ? WHERE id = ?', e.message, i.id);
    return { ok: false, error: e.message };
  }
}

export function startScheduler() {
  for (const j of all('SELECT id FROM jobs')) refreshNextRun(j.id as number);
  setInterval(tick, 30_000);
  const poll = async () => { for (const i of all('SELECT * FROM instances')) await refreshInstance(i as any); };
  setTimeout(poll, 5_000);
  setInterval(poll, 10 * 60_000);
}
