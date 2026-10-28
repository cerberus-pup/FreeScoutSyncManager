// Usage: node dist/cli.js set-password <username>   (password read from stdin)
//        node dist/cli.js set-setting <key> <value>
import { one, exec, setSetting } from './db.js';
import { hashPassword } from './auth.js';

const [cmd, username] = process.argv.slice(2);
if (cmd === 'set-setting') {
  const [, key, value = ''] = process.argv.slice(2);
  if (!['agent_from'].includes(key)) { console.error('unknown setting'); process.exit(2); }
  if (value && !/^[0-9A-Fa-f.:/,]+$/.test(value)) { console.error('agent_from must be IPs/CIDRs'); process.exit(2); }
  setSetting(key, value);
  console.log(`${key} = ${value}`);
  process.exit(0);
}
if (cmd !== 'set-password' || !username || !/^[A-Za-z0-9._-]{2,64}$/.test(username)) {
  console.error('usage: cli.js set-password <username>   (password on stdin)');
  process.exit(2);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => (input += d));
process.stdin.on('end', () => {
  const pw = input.replace(/\r?\n$/, '');
  if (pw.length < 10) { console.error('password must be at least 10 characters'); process.exit(1); }
  const h = hashPassword(pw);
  if (one('SELECT id FROM users WHERE username = ?', username)) exec('UPDATE users SET pass_hash = ? WHERE username = ?', h, username);
  else exec('INSERT INTO users(username, pass_hash) VALUES (?, ?)', username, h);
  exec('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)', username);
  console.log(`password set for ${username}`);
});
