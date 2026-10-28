import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { one, exec } from './db.js';
import { SESSION_HOURS } from './config.js';

const N = 32768, R = 8, P = 1, KEYLEN = 64, MAXMEM = 128 * 1024 * 1024;

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), expected.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
  return crypto.timingSafeEqual(expected, got);
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const COOKIE = 'fsm_sid';

export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('base64url');
  exec('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    sha(token), userId, Date.now() + SESSION_HOURS * 3600_000);
  exec('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  return token;
}
export function destroySession(token: string) { exec('DELETE FROM sessions WHERE token_hash = ?', sha(token)); }

export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function setSessionCookie(req: Request, res: Response, token: string | null) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict', secure ? 'Secure' : ''].filter(Boolean);
  if (token) attrs.push(`Max-Age=${SESSION_HOURS * 3600}`); else attrs.push('Max-Age=0');
  res.setHeader('Set-Cookie', `${COOKIE}=${token ? encodeURIComponent(token) : ''}; ${attrs.join('; ')}`);
}

/** Requires a valid session; non-GET requests must also carry X-FSM: 1 (CSRF guard with SameSite=Strict). */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = readCookie(req, COOKIE);
  const sess = token ? one('SELECT s.user_id, s.expires_at, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?', sha(token)) : undefined;
  if (!sess || sess.expires_at < Date.now()) { res.status(401).json({ error: 'Not signed in' }); return; }
  if (req.method !== 'GET' && req.get('X-FSM') !== '1') { res.status(403).json({ error: 'Missing request header' }); return; }
  // sliding expiry
  exec('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', Date.now() + SESSION_HOURS * 3600_000, sha(token!));
  (req as any).user = { id: sess.user_id, username: sess.username };
  next();
}

// Simple in-memory login throttle: 10 failures per IP per 15 minutes
const failures = new Map<string, { count: number; until: number }>();
export function loginBlocked(ip: string): boolean {
  const f = failures.get(ip);
  return !!f && f.count >= 10 && f.until > Date.now();
}
export function loginFailed(ip: string) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) failures.set(ip, { count: 1, until: Date.now() + 15 * 60_000 });
  else f.count++;
}
export function loginOk(ip: string) { failures.delete(ip); }
