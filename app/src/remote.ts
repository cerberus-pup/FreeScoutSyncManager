import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SSH_DIR, SSH_KEY, KNOWN_HOSTS, DATA_DIR, RSYNC_EXCLUDES } from './config.js';

export interface Instance { id: number; name: string; host: string; port: number; ssh_user: string }

export interface RunOpts {
  stdinFile?: string;
  stdinData?: string;
  stdoutFile?: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
  timeoutMs?: number;
}
export interface RunResult { code: number; stdout: string; stderr: string }

export class RemoteError extends Error {
  constructor(msg: string, public stderr = '') { super(msg); }
}

export function ensureSshKey() {
  fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(SSH_KEY)) {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `fsmanager@${os.hostname()}`, '-f', SSH_KEY]);
  }
  if (!fs.existsSync(KNOWN_HOSTS)) fs.writeFileSync(KNOWN_HOSTS, '', { mode: 0o600 });
}
export const publicKey = () => fs.readFileSync(SSH_KEY + '.pub', 'utf8').trim();

const EXCLUDES_FILE = path.join(DATA_DIR, 'rsync-excludes');
function excludesFile() {
  fs.writeFileSync(EXCLUDES_FILE, RSYNC_EXCLUDES.join('\n') + '\n', { mode: 0o600 });
  return EXCLUDES_FILE;
}

function sshOpts(i: Instance): string[] {
  return ['-i', SSH_KEY, '-p', String(i.port),
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`, '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6', '-o', 'LogLevel=ERROR'];
}
const hostPart = (h: string) => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);

/** Spawn a process, streaming stdin/stdout to files when asked; stderr goes to the run log. */
export function runProcess(cmd: string, args: string[], o: RunOpts = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return reject(new RemoteError('Cancelled'));
    const useStdin = !!(o.stdinFile || o.stdinData !== undefined);
    const child = spawn(cmd, args, { stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '', stderrTail = '', settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); fn(); } };
    const onAbort = () => child.kill('SIGTERM');
    o.signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => { o.log?.(`timeout after ${o.timeoutMs} ms - killing ${cmd}`); child.kill('SIGTERM'); }, o.timeoutMs ?? 6 * 3600_000);

    let outDone: Promise<void> = Promise.resolve();
    if (o.stdoutFile) {
      const ws = fs.createWriteStream(o.stdoutFile, { mode: 0o600 });
      child.stdout!.pipe(ws);
      outDone = new Promise((res, rej) => { ws.on('finish', () => res()); ws.on('error', rej); });
    } else {
      child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); if (stdout.length > 4_000_000) stdout = stdout.slice(-4_000_000); });
    }
    let partial = '';
    child.stderr!.on('data', (d: Buffer) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-4000);
      partial += s;
      const lines = partial.split(/\r?\n/); partial = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) o.log?.(l);
    });
    if (useStdin) {
      child.stdin!.on('error', () => { /* remote closed early; exit code tells the story */ });
      if (o.stdinFile) fs.createReadStream(o.stdinFile).on('error', e => { child.kill(); finish(() => reject(e)); }).pipe(child.stdin!);
      else { child.stdin!.end(o.stdinData); }
    }
    child.on('error', e => finish(() => reject(new RemoteError(`${cmd}: ${e.message}`))));
    child.on('close', async (code, sig) => {
      if (partial.trim()) o.log?.(partial);
      try { await outDone; } catch (e: any) { return finish(() => reject(new RemoteError(`writing output: ${e.message}`))); }
      finish(() => {
        if (o.signal?.aborted) return reject(new RemoteError('Cancelled'));
        resolve({ code: code ?? (sig ? 128 : 1), stdout, stderr: stderrTail });
      });
    });
  });
}

function explain(r: RunResult, what: string): RemoteError {
  const err = r.stderr.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
  let hint = '';
  if (/Permission denied \(publickey/.test(r.stderr)) hint = ' - the manager key is not authorized: run the agent install command on this server';
  else if (/Connection refused|timed out|No route to host|Could not resolve/.test(r.stderr)) hint = ' - check host/port and that SSH is reachable from the manager';
  else if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(r.stderr)) hint = ' - the server host key changed; if expected, use "Reset host key" on the instance';
  return new RemoteError(`${what} failed (exit ${r.code})${err ? ': ' + err : ''}${hint}`, r.stderr);
}

/** Run an fs-agent sub-command on the instance. */
export async function agent(i: Instance, args: string[], o: RunOpts = {}): Promise<string> {
  const r = await runProcess('ssh', [...sshOpts(i), `${i.ssh_user}@${i.host}`, args.join(' ')], o);
  if (r.code !== 0) throw explain(r, `agent ${args[0]}`);
  return r.stdout;
}
export async function agentJson<T = any>(i: Instance, args: string[], o: RunOpts = {}): Promise<T> {
  const out = (await agent(i, args, o)).trim().split('\n').pop() ?? '';
  try { return JSON.parse(out) as T; } catch { throw new RemoteError(`agent ${args[0]}: unexpected output: ${out.slice(0, 200)}`); }
}

export interface RsyncStats { files: number; transferredBytes: number; totalBytes: number }
function parseStats(out: string): RsyncStats {
  const num = (re: RegExp) => Number((out.match(re)?.[1] ?? '0').replace(/[,.](?=\d{3})/g, ''));
  return {
    files: num(/Number of regular files transferred:\s*([\d,.]+)/),
    transferredBytes: num(/Total transferred file size:\s*([\d,.]+)/),
    totalBytes: num(/Total file size:\s*([\d,.]+)/),
  };
}

async function rsync(args: string[], o: RunOpts, what: string): Promise<RsyncStats> {
  const r = await runProcess('rsync', args, o);
  // 24 = some files vanished during transfer (normal on a live server)
  if (r.code !== 0 && r.code !== 24) throw explain(r, what);
  if (r.code === 24) o.log?.('note: some files changed/vanished during copy (normal on a live server)');
  return parseStats(r.stdout);
}
const baseRsync = (i: Instance) => ['-rlpt', '--delete', '--stats', `--exclude-from=${excludesFile()}`,
  '-e', ['ssh', ...sshOpts(i)].join(' ')];

export function rsyncPull(i: Instance, remoteDir: string, localDir: string, linkDests: string[], o: RunOpts) {
  const args = baseRsync(i);
  for (const d of linkDests.slice(0, 20)) args.push(`--link-dest=${d}`);
  args.push(`${i.ssh_user}@${hostPart(i.host)}:${remoteDir.replace(/\/?$/, '/')}`, localDir.replace(/\/?$/, '/'));
  return rsync(args, o, 'file copy from source');
}
/** extraExcludes: patterns relative to localDir; excluded paths on the target are also never deleted. */
export function rsyncPush(i: Instance, localDir: string, remoteDir: string, o: RunOpts, extraExcludes: string[] = []) {
  const args = [...baseRsync(i), ...extraExcludes.map(p => `--exclude=${p}`), localDir.replace(/\/?$/, '/'), `${i.ssh_user}@${hostPart(i.host)}:${remoteDir.replace(/\/?$/, '/')}`];
  return rsync(args, o, 'file copy to target');
}

export function hostKeyFingerprint(i: Instance): string | null {
  const name = i.port === 22 ? i.host : `[${i.host}]:${i.port}`;
  try {
    const out = execFileSync('ssh-keygen', ['-l', '-F', name, '-f', KNOWN_HOSTS], { encoding: 'utf8' });
    return out.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0] ?? null;
  } catch { return null; }
}
export function resetHostKey(i: Instance) {
  const name = i.port === 22 ? i.host : `[${i.host}]:${i.port}`;
  try { execFileSync('ssh-keygen', ['-R', name, '-f', KNOWN_HOSTS], { stdio: 'ignore' }); } catch { /* none */ }
}

/** Size on disk counting hard-linked files once (snapshots share unchanged files). */
export async function diskUsage(dir: string): Promise<number> {
  const r = await runProcess('du', ['-sb', dir]);
  return Number(r.stdout.split(/\s/)[0]) || 0;
}
