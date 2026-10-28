import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const APP_DIR = path.resolve(here, '..');
export const DATA_DIR = process.env.FSM_DATA ?? '/var/lib/fsmanager';
export const PORT = Number(process.env.FSM_PORT ?? 8080);
export const BIND = process.env.FSM_BIND ?? '127.0.0.1';
export const AGENT_DIR = process.env.FSM_AGENT_DIR ?? path.resolve(APP_DIR, '..', 'agent');

export const SSH_DIR = path.join(DATA_DIR, 'ssh');
export const SSH_KEY = path.join(SSH_DIR, 'id_ed25519');
export const KNOWN_HOSTS = path.join(SSH_DIR, 'known_hosts');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const DB_FILE = path.join(DATA_DIR, 'fsmanager.db');

export const AGENT_VERSION = '1.2.1';
export const SESSION_HOURS = 12;

/** Top-level folders under storage/app that hold a server's own SSO material (certificates, metadata). */
export const SSO_STORAGE_DIRS = ['saml*', 'Saml*', 'SAML*', 'oauth*', 'OAuth*', 'sso*', 'SSO*', 'socialite*'];

/** Paths never copied between instances: per-server config, caches, logs, generated builds. */
export const RSYNC_EXCLUDES = [
  '/.env',
  '/storage/logs/',
  '/storage/framework/',
  '/bootstrap/cache/',
  '/public/js/builds/',
  '/public/css/builds/',
  '/public/storage',
];
