'use strict';
/* FreeScout Sync Manager - single-page UI (no build step). All server data is escaped via esc(). */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { me: null, settings: null, timer: null, route: '' };

async function api(method, url, body) {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: { 'X-FSM': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !url.endsWith('/login')) { state.me = null; renderLogin(); throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ── formatting ──
const fmtBytes = n => n == null ? '–' : n >= 1e12 ? (n / 1e12).toFixed(2) + ' TB' : n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B';
const fmtNum = n => n == null ? '–' : Number(n).toLocaleString();
const parseDate = s => s ? new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z') : null;
const fmtDate = s => { const d = parseDate(s); return d ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '–'; };
function ago(s) {
  const d = parseDate(s); if (!d) return 'never';
  const sec = (Date.now() - d) / 1000, fut = sec < 0, a = Math.abs(sec);
  const t = a < 60 ? 'moments' : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} days`;
  return fut ? `in ${t}` : (t === 'moments' ? 'just now' : `${t} ago`);
}
function dur(a, b) {
  const s = Math.round(((b ? parseDate(b) : new Date()) - parseDate(a)) / 1000);
  if (!a || isNaN(s)) return '';
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
}
const RUN_LABEL = { success: 'Succeeded', warning: 'Done with warnings', failed: 'Failed', running: 'Running', queued: 'Queued', cancelled: 'Cancelled' };
const runPill = st => `<span class="pill ${esc(st)}">${esc(RUN_LABEL[st] || st)}</span>`;
const TYPE_LABEL = { backup: 'Backup', sync: 'Sync', migrate: 'Migration', restore: 'Restore', switch: 'Mail switch' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function scheduleText(s) {
  if (!s || s.kind === 'manual') return 'Manual only';
  if (s.kind === 'hourly') return s.every === 1 ? `Every hour at :${String(s.minute ?? 0).padStart(2, '0')}` : `Every ${s.every} hours`;
  if (s.kind === 'daily') return `Daily at ${s.time}`;
  return `${WEEKDAYS[s.weekday ?? 0]}s at ${s.time}`;
}
function instStatus(i) {
  if (i.last_error) return '<span class="pill fail">Unreachable</span>';
  const info = i.last_info;
  if (!info) return '<span class="pill">Not checked yet</span>';
  if (info.maintenance) return '<span class="pill warn">Maintenance</span>';
  if (info.standby) return '<span class="pill standby" title="Standby: the site is up but does not fetch or send mail">Mail off</span>';
  return '<span class="pill ok" title="Active: fetching and sending mail">Mail on</span>';
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = ''), isError ? 6000 : 3000);
}

// ── dialogs ──
function openDialog(html, onSubmit, { wide = false } = {}) {
  const d = document.createElement('dialog');
  if (wide) d.style.width = 'min(760px, calc(100vw - 2rem))';
  d.innerHTML = `<form method="dialog" novalidate>${html}<p class="err-msg" role="alert"></p></form>`;
  document.body.appendChild(d);
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', e => { if (e.target.closest('[data-close]')) { e.preventDefault(); d.close(); } });
  const form = $('form', d);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!onSubmit) return d.close();
    const btn = $('button[type=submit]', form); if (btn) btn.disabled = true;
    try { if ((await onSubmit(new FormData(form), d)) !== false) d.close(); }
    catch (err) { $('.err-msg', form).textContent = err.message; }
    finally { if (btn) btn.disabled = false; }
  });
  d.showModal();
  const first = $('input:not([type=hidden]), select, textarea', d); if (first) first.focus();
  return d;
}
function confirmDialog(title, body, action, { danger = true } = {}) {
  return new Promise(resolve => {
    const d = openDialog(`<h2>${esc(title)}</h2><p>${body}</p>
      <div class="foot"><button type="button" data-close>Keep it</button>
      <button type="submit" class="${danger ? 'danger solid' : 'primary'}">${esc(action)}</button></div>`, () => resolve(true));
    d.addEventListener('close', () => resolve(false));
  });
}

// ── shell ──
const NAV = [['#/', 'Overview'], ['#/instances', 'Instances'], ['#/jobs', 'Jobs'], ['#/runs', 'Runs'], ['#/backups', 'Backups'], ['#/settings', 'Settings']];
const LOGO = `<svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><circle cx="8" cy="16" r="5.5" fill="#5FC2CF"/><circle cx="24" cy="16" r="5.5" fill="#7BD39F"/><path d="M14 16h5" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/></svg>`;

function renderShell() {
  const active = '#/' + (location.hash.replace(/^#\//, '').split('/')[0] || '');
  $('#app').innerHTML = `<div class="shell">
    <nav class="rail" aria-label="Main">
      <div class="brand">${LOGO}<div>FreeScout Sync<small>Manager</small></div></div>
      ${NAV.map(([h, l]) => `<a href="${h}" ${h === active ? 'aria-current="page"' : ''}>${l}<span data-badge="${l}"></span></a>`).join('')}
      <div class="spacer"></div>
      <div class="who">Signed in as ${esc(state.me)}</div>
      <a href="#" data-action="logout">Sign out</a>
    </nav>
    <main id="main"><p class="muted">Loading…</p></main></div>`;
}

function renderLogin(err = '') {
  clearInterval(state.timer);
  $('#app').innerHTML = `<div class="login"><div class="box">
    <div class="brand">${LOGO.replace('#fff', 'currentColor')}<div>FreeScout Sync Manager<small>Sign in to manage backups and syncs</small></div></div>
    <form class="panel" id="login-form"><div class="panel-body">
      <div class="field"><label for="u">Username</label><input id="u" name="username" autocomplete="username" required></div>
      <div class="field"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>
      <button class="primary" type="submit" style="width:100%;justify-content:center">Sign in</button>
      <p class="err-msg" role="alert">${esc(err)}</p>
    </div></form></div></div>`;
  $('#u').focus();
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await api('POST', '/api/login', { username: f.get('username'), password: f.get('password') });
      state.me = r.username; route();
    } catch (er) { $('.err-msg').textContent = er.message; }
  });
}

// ── router ──
async function route() {
  clearInterval(state.timer);
  if (!state.me) {
    try { state.me = (await api('GET', '/api/me')).username; } catch { return renderLogin(); }
  }
  const parts = location.hash.replace(/^#\//, '').split('/');
  const section = parts[0] || '';
  const key = section + (parts[1] ? '/' : '');
  renderShell();
  state.route = key;
  const views = { '': viewOverview, instances: viewInstances, jobs: viewJobs, runs: viewRuns, 'runs/': () => viewRun(Number(parts[1])), backups: viewBackups, settings: viewSettings };
  const v = views[key] || viewOverview;
  try { await v(); } catch (e) { if (e.message !== 'Signed out') $('#main').innerHTML = `<div class="callout fail">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);
function poll(fn, ms) {
  clearInterval(state.timer);
  let busy = false;   // never run two refreshes at once (a slow one would otherwise overlap the next)
  state.timer = setInterval(async () => {
    if (document.hidden || busy) return;
    busy = true;
    try { await fn(); } catch { /* shown on next refresh */ } finally { busy = false; }
  }, ms);
}
const main = () => $('#main');

// ── overview ──
async function viewOverview() {
  const draw = async () => {
    const d = await api('GET', '/api/dashboard');
    const running = d.runs.filter(r => r.status === 'running' || r.status === 'queued').length;
    const online = d.instances.filter(i => i.last_info && !i.last_error).length;
    const lastBackup = d.runs.find(r => (r.type === 'backup' || r.type === 'sync' || r.type === 'migrate') && (r.status === 'success' || r.status === 'warning'));
    const used = d.storage.backups_bytes, total = d.storage.total_bytes, free = d.storage.free_bytes;
    const lanes = d.jobs.filter(j => j.type !== 'backup');
    const name = id => d.instances.find(i => i.id === id)?.name ?? '(deleted)';
    const instById = id => d.instances.find(i => i.id === id);
    main().innerHTML = `
      <div class="page-head"><div><h1>Overview</h1><p>Every FreeScout server you manage, and how data moves between them.</p></div>
        <div class="actions"><a class="btn" href="#/instances">Add an instance</a><a class="btn" href="#/jobs">Create a job</a></div></div>
      <div class="strip">
        <div><div class="v">${online}/${d.instances.length}</div><div class="k">instances reachable</div></div>
        <div><div class="v">${running}</div><div class="k">${running === 1 ? 'run' : 'runs'} in progress or queued</div></div>
        <div><div class="v">${lastBackup ? esc(ago(lastBackup.finished_at)) : 'none yet'}</div><div class="k">last successful backup</div></div>
        <div><div class="v">${fmtBytes(used)}</div><div class="k">${d.snapshots} snapshots, ${fmtBytes(free)} free on this server</div>
          <div class="meter" title="Backup storage"><i style="width:${total ? Math.min(100, (used / total) * 100).toFixed(1) : 0}%"></i></div></div>
      </div>
      <section><h2>Sync and migration lanes</h2>
        ${lanes.length ? `<div class="lanes">${lanes.map(j => {
          const st = j.last_run?.status ?? 'none', s = instById(j.source_id), t = instById(j.target_id);
          return `<div class="lane">
            <div class="end"><h3>${esc(name(j.source_id))}</h3><div class="small muted">${esc(s?.last_info?.app_url ?? s?.host ?? '')}</div><div>${s ? instStatus(s) : ''}</div></div>
            <div class="wire ${esc(st)}"><span>${esc(TYPE_LABEL[j.type])}</span></div>
            <div class="end"><h3>${esc(name(j.target_id))}</h3><div class="small muted">${esc(t?.last_info?.app_url ?? t?.host ?? '')}</div><div>${t ? instStatus(t) : ''}</div></div>
            <div class="small" style="text-align:right">
              <div>${j.last_run ? `<a href="#/runs/${j.last_run.id}">${runPill(j.last_run.status)}</a>` : '<span class="muted">Never run</span>'}</div>
              <div class="muted">${j.enabled && j.next_run_at ? 'Next ' + esc(ago(j.next_run_at)) : esc(scheduleText(j.schedule))}</div>
              <button class="small" data-action="run-job" data-id="${j.id}" style="margin-top:.35rem">Run now</button>
            </div></div>`; }).join('')}</div>`
        : `<div class="panel empty"><p>No sync or migration jobs yet. A sync job keeps a standby copy of one instance on another.</p><a class="btn" href="#/jobs">Create a job</a></div>`}
      </section>
      <section><h2>Recent runs</h2>${runsTable(d.runs, true)}</section>`;
  };
  await draw();
  poll(draw, 5000);
}

function runsTable(runs, compact = false) {
  if (!runs.length) return `<div class="panel empty"><p>Nothing has run yet. Runs appear here as soon as a job starts.</p></div>`;
  return `<div class="panel table-wrap"><table>
    <thead><tr><th>Run</th><th>What</th><th>Status</th><th>Started</th><th>Duration</th>${compact ? '' : '<th>Trigger</th>'}</tr></thead>
    <tbody>${runs.map(r => `<tr class="clickable" data-href="#/runs/${r.id}">
      <td class="num"><a href="#/runs/${r.id}">#${r.id}</a></td>
      <td><b>${esc(TYPE_LABEL[r.type] || r.type)}</b> ${r.type === 'switch' ? `mail on for ${esc(r.target_name)}` : `${esc(r.source_name ?? '')}${r.target_name ? ` → ${esc(r.target_name)}` : ''}`}
        ${r.job_name ? `<div class="small muted">${esc(r.job_name)}</div>` : ''}${r.error ? `<div class="small" style="color:var(--fail)">${esc(r.error)}</div>` : ''}</td>
      <td>${runPill(r.status)}</td>
      <td class="small" title="${esc(fmtDate(r.started_at || r.queued_at))}">${esc(ago(r.started_at || r.queued_at))}</td>
      <td class="small num">${esc(r.started_at ? dur(r.started_at, r.finished_at) : '')}</td>
      ${compact ? '' : `<td class="small muted">${esc(r.trigger === 'schedule' ? 'Schedule' : 'Manual')}</td>`}
    </tr>`).join('')}</tbody></table></div>`;
}

// ── instances ──
async function viewInstances() {
  const draw = async () => {
    const list = await api('GET', '/api/instances');
    main().innerHTML = `
      <div class="page-head"><div><h1>Instances</h1><p>FreeScout servers this manager can back up, sync and migrate. Each one runs a small agent reached over SSH.</p></div>
        <button class="primary" data-action="add-instance">Add instance</button></div>
      <div class="panel">${list.length ? list.map(instanceRow).join('') : `<div class="empty"><p>Add your first FreeScout server. You'll run one command on it to install the agent.</p><button class="primary" data-action="add-instance">Add instance</button></div>`}</div>`;
  };
  await draw();
  poll(draw, 15000);
}
function instanceRow(i) {
  const info = i.last_info || {}, st = i.last_stats || {};
  return `<div class="inst">
    <div><h3>${esc(i.name)}</h3>
      <div class="small muted">${esc(i.ssh_user)}@${esc(i.host)}${i.port !== 22 ? ':' + i.port : ''}</div>
      <div style="margin:.35rem 0">${instStatus(i)}</div>
      ${info.app_url ? `<div class="small"><a href="${esc(info.app_url)}" target="_blank" rel="noopener">${esc(info.app_url)}</a></div>` : ''}
      <div class="small muted">Checked ${esc(ago(i.last_seen_at))}</div></div>
    <div class="facts">
      <div><span>FreeScout</span><b>${esc(info.freescout_version ?? '–')}</b></div>
      <div><span>PHP</span><b>${esc(info.php_version ?? '–')}</b></div>
      <div><span>Conversations</span><b>${fmtNum(st.conversations)}</b></div>
      <div><span>Customers</span><b>${fmtNum(st.customers)}</b></div>
      <div><span>Database</span><b>${fmtBytes(info.db_bytes)}</b></div>
      <div><span>Attachments and files</span><b>${fmtBytes(info.files_bytes)}</b></div>
      <div><span>Disk free</span><b>${fmtBytes(info.disk_free_bytes)}</b></div>
      <div><span>Agent</span><b>${esc(info.agent_version ?? '–')}</b></div>
    </div>
    <div class="actions" style="justify-content:flex-end">
      <button class="small" data-action="test-instance" data-id="${i.id}">Check now</button>
      <button class="small" data-action="backup-instance" data-id="${i.id}">Back up now</button>
      ${info.standby === true ? `<button class="small primary" data-action="mail-on" data-id="${i.id}">Turn mail on…</button>`
        : info.standby === false ? `<button class="small" data-action="set-mode" data-mode="standby" data-id="${i.id}" data-name="${esc(i.name)}">Turn mail off</button>` : ''}
      <button class="small" data-action="edit-instance" data-id="${i.id}">Edit</button>
    </div>
    ${i.last_error ? `<div class="err">${esc(i.last_error)}</div>` : ''}
    ${info.scheduler_found === false ? `<div class="err" style="background:var(--warn-bg);color:var(--warn)">No cron entry runs this FreeScout's scheduler, so it won't fetch mail even when active.</div>` : ''}
  </div>`;
}

async function settings() { return state.settings ??= await api('GET', '/api/settings'); }

async function instanceDialog(existing) {
  const s = await settings();
  const i = existing || { name: '', host: '', port: 22, ssh_user: 'fsagent', notes: '' };
  openDialog(`<h2>${existing ? 'Edit instance' : 'Add a FreeScout instance'}</h2>
    ${existing ? '' : `<ol class="steps">
      <li>On the FreeScout server, install the agent:
        <div class="codebox" style="margin-top:.4rem"><code>${esc(s.install_command)}</code><button type="button" class="small" data-copy="${esc(s.install_command)}">Copy</button></div>
        <div class="small muted" style="margin-top:.3rem">It creates a locked-down <code>fsagent</code> user that accepts only this manager's key and can only run the agent. Add <code>--dir /path</code> if FreeScout isn't in <code>/var/www/freescout</code>.</div></li>
      <li>Fill in the server details below, then save. The manager checks the connection straight away.</li></ol>`}
    <div class="field"><label for="f-name">Name</label><input id="f-name" name="name" value="${esc(i.name)}" placeholder="Helpdesk (production)" required></div>
    <div class="row">
      <div class="field"><label for="f-host">Host or IP</label><input id="f-host" name="host" value="${esc(i.host)}" placeholder="helpdesk.example.local" required></div>
      <div class="field"><label for="f-port">SSH port</label><input id="f-port" name="port" type="number" min="1" max="65535" value="${esc(i.port)}"></div>
      <div class="field"><label for="f-user">SSH user</label><input id="f-user" name="ssh_user" value="${esc(i.ssh_user)}"></div>
    </div>
    <div class="field"><label for="f-notes">Notes</label><textarea id="f-notes" name="notes" rows="2">${esc(i.notes)}</textarea></div>
    ${existing ? `<p class="small muted">Host key: ${esc(existing.host_key ?? 'not recorded yet')}</p>` : ''}
    <div class="foot">
      ${existing ? `<button type="button" class="danger" data-action="delete-instance" data-id="${i.id}" style="margin-right:auto">Delete</button>
        <button type="button" data-action="reset-hostkey" data-id="${i.id}">Reset host key</button>` : ''}
      <button type="button" data-close>Cancel</button><button type="submit" class="primary">${existing ? 'Save changes' : 'Add and check'}</button></div>`,
  async f => {
    const body = { name: f.get('name'), host: f.get('host'), port: Number(f.get('port') || 22), ssh_user: f.get('ssh_user'), notes: f.get('notes') };
    const saved = existing ? await api('PUT', `/api/instances/${existing.id}`, body) : await api('POST', '/api/instances', body);
    toast(existing ? 'Instance saved' : 'Instance added, checking connection…');
    if (!existing) api('POST', `/api/instances/${saved.id}/test`).then(r => { toast(r.ok ? `${saved.name} is reachable` : r.error, !r.ok); route(); }).catch(() => {});
    route();
  }, { wide: !existing });
}

// ── mail switch ──
async function mailOnDialog(id) {
  const insts = await api('GET', '/api/instances');
  const on = insts.find(i => i.id === id);
  const others = insts.filter(i => i.id !== id);
  const row = i => {
    const mailOn = i.last_info && i.last_info.standby === false;
    return `<label class="check"><input type="checkbox" name="off" value="${i.id}" ${mailOn ? 'checked' : ''}>
      <span><b>${esc(i.name)}</b> ${instStatus(i)}<br><span class="small muted">${esc(i.last_info?.app_url ?? i.host)}${i.last_error ? ' - last check failed' : ''}</span></span></label>`;
  };
  openDialog(`<h2>Turn mail on for ${esc(on.name)}</h2>
    <p>${esc(on.name)} will start fetching and sending mail. Only one server should do that for the same mailboxes, or customers get duplicate replies and new mail is split between servers.</p>
    <div class="field"><label>Turn mail off first on</label>
      ${others.length ? others.map(row).join('') : '<p class="small muted">There are no other servers.</p>'}
      <p class="hint">Servers that have mail on are ticked. Mail is turned off on these before it is turned on for ${esc(on.name)}.</p></div>
    <label class="check"><input type="checkbox" name="force"> Turn mail on anyway if a server above can't be reached (use when that server is down - turn its mail off as soon as it's back)</label>
    <div class="foot"><button type="button" data-close>Cancel</button><button type="submit" class="primary">Switch mail to ${esc(on.name)}</button></div>`,
  async f => {
    const r = await api('POST', `/api/instances/${id}/mail-on`, { off_ids: f.getAll('off').map(Number), force: f.get('force') === 'on' });
    toast('Mail switch started'); location.hash = `#/runs/${r.run_id}`;
  });
}

// ── jobs ──
async function viewJobs() {
  const [jobs, insts] = await Promise.all([api('GET', '/api/jobs'), api('GET', '/api/instances')]);
  const name = id => insts.find(i => i.id === id)?.name ?? '(deleted)';
  main().innerHTML = `
    <div class="page-head"><div><h1>Jobs</h1><p>Saved backups, syncs and migrations. Scheduled jobs run on this server's clock.</p></div>
      <button class="primary" data-action="add-job" ${insts.length ? '' : 'disabled title="Add an instance first"'}>Create job</button></div>
    ${jobs.length ? `<div class="panel table-wrap"><table><thead><tr><th>Job</th><th>From → to</th><th>Schedule</th><th>Keeps</th><th>Last run</th><th></th></tr></thead><tbody>
      ${jobs.map(j => `<tr>
        <td><b>${esc(j.name)}</b><div class="small muted">${esc(TYPE_LABEL[j.type])}${j.enabled ? '' : ' (paused)'}</div></td>
        <td>${esc(name(j.source_id))}${j.target_id ? ` → ${esc(name(j.target_id))}` : ''}</td>
        <td class="small">${esc(scheduleText(j.schedule))}${j.enabled && j.next_run_at ? `<div class="muted">Next ${esc(ago(j.next_run_at))}</div>` : ''}</td>
        <td class="small num">${j.retention} snapshots</td>
        <td>${j.last_run ? `<a href="#/runs/${j.last_run.id}">${runPill(j.last_run.status)}</a><div class="small muted">${esc(ago(j.last_run.finished_at || j.last_run.started_at))}</div>` : '<span class="small muted">Never</span>'}</td>
        <td><div class="actions" style="justify-content:flex-end"><button class="small" data-action="run-job" data-id="${j.id}">Run now</button><button class="small" data-action="edit-job" data-id="${j.id}">Edit</button></div></td>
      </tr>`).join('')}</tbody></table></div>`
    : `<div class="panel empty"><p>${insts.length ? 'Create a backup job for each instance, then a sync job to keep a standby copy up to date.' : 'Add an instance first, then create jobs for it.'}</p>
        ${insts.length ? '<button class="primary" data-action="add-job">Create job</button>' : '<a class="btn" href="#/instances">Add an instance</a>'}</div>`}`;
}

const TYPE_HELP = {
  backup: 'Copies the database, attachments, modules and app files to this manager. Each snapshot only stores files that changed since the last one.',
  sync: 'Backs up the source, then restores it onto the target, which is left in standby (site up, no mail fetched or sent). Use it for a warm spare. Everything on the target is replaced.',
  migrate: 'A one-time move: copies the source onto the target, makes the target active, and can put the source in standby so only one server fetches mail. Everything on the target is replaced.',
};
async function jobDialog(existing) {
  const insts = await api('GET', '/api/instances');
  const j = existing || { name: '', type: 'backup', source_id: insts[0]?.id, target_id: insts[1]?.id, schedule: { kind: 'daily', time: '01:30' }, retention: 7, options: { activate_target: true, standby_source: true }, enabled: true };
  const opt = (sel) => insts.map(i => `<option value="${i.id}" ${i.id === sel ? 'selected' : ''}>${esc(i.name)}</option>`).join('');
  const s = j.schedule;
  const d = openDialog(`<h2>${existing ? 'Edit job' : 'Create a job'}</h2>
    <div class="field"><label>Type</label><div class="segmented" role="group">
      ${['backup', 'sync', 'migrate'].map(t => `<button type="button" data-type="${t}" aria-pressed="${j.type === t}">${TYPE_LABEL[t]}</button>`).join('')}</div>
      <p class="hint" id="type-help" style="margin-top:.5rem">${esc(TYPE_HELP[j.type])}</p></div>
    <input type="hidden" name="type" value="${esc(j.type)}">
    <div class="field"><label for="j-name">Name</label><input id="j-name" name="name" value="${esc(j.name)}" placeholder="Nightly backup of production"></div>
    <div class="row">
      <div class="field"><label for="j-src">Source</label><select id="j-src" name="source_id">${opt(j.source_id)}</select></div>
      <div class="field" id="tgt-field"><label for="j-tgt">Target (gets overwritten)</label><select id="j-tgt" name="target_id">${opt(j.target_id)}</select></div>
    </div>
    <div class="row" id="sched-row">
      <div class="field"><label for="j-kind">Schedule</label><select id="j-kind" name="kind">
        ${[['manual', 'Manual only'], ['hourly', 'Every few hours'], ['daily', 'Daily'], ['weekly', 'Weekly']].map(([v, l]) => `<option value="${v}" ${s.kind === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field" data-for="hourly"><label for="j-every">Every (hours)</label><input id="j-every" name="every" type="number" min="1" max="24" value="${esc(s.every ?? 4)}"></div>
      <div class="field" data-for="weekly"><label for="j-wd">Day</label><select id="j-wd" name="weekday">${WEEKDAYS.map((w, n) => `<option value="${n}" ${n === (s.weekday ?? 0) ? 'selected' : ''}>${w}</option>`).join('')}</select></div>
      <div class="field" data-for="daily weekly"><label for="j-time">Time</label><input id="j-time" name="time" type="time" value="${esc(s.time ?? '01:30')}"></div>
    </div>
    <div class="field" id="ret-field"><label for="j-ret">Snapshots to keep</label><input id="j-ret" name="retention" type="number" min="1" max="365" value="${esc(j.retention)}">
      <p class="hint">Older snapshots from this job are deleted after each successful run. Pinned snapshots are always kept.</p></div>
    <div class="field" id="files-field"><label for="j-files">What to copy</label>
      <select id="j-files" name="files">
        <option value="auto" ${(j.options?.files ?? 'auto') === 'auto' ? 'selected' : ''}>Automatic (recommended)</option>
        <option value="data" ${(j.options?.files ?? 'auto') === 'data' ? 'selected' : ''}>Data only: keep the target's FreeScout version</option>
        <option value="full" ${(j.options?.files ?? 'auto') === 'full' ? 'selected' : ''}>Everything: exact clone, including the source's FreeScout version</option></select>
      <p class="hint">Automatic copies everything when both run the same FreeScout version. When the target runs a newer FreeScout, it copies only the data (database, attachments, modules) and upgrades the database there. A target running an older FreeScout is refused.</p></div>
    <label class="check" id="sso-opt"><input type="checkbox" name="keep_sso" ${j.options?.keep_sso !== false ? 'checked' : ''}> Keep the target's own SSO setup (SAML / OAuth module settings, their licenses and certificates) - recommended, since SSO is tied to each server's address</label>
    <div id="mig-opts">
      <label class="check"><input type="checkbox" name="activate_target" ${j.options?.activate_target !== false ? 'checked' : ''}> Make the target active when the copy finishes (it starts fetching and sending mail)</label>
      <label class="check"><input type="checkbox" name="standby_source" ${j.options?.standby_source !== false ? 'checked' : ''}> Put the source in standby afterwards, so two servers never fetch the same mailbox</label>
    </div>
    <label class="check"><input type="checkbox" name="enabled" ${j.enabled ? 'checked' : ''}> Job is enabled (scheduled runs happen)</label>
    <div class="foot">${existing ? `<button type="button" class="danger" data-action="delete-job" data-id="${j.id}" style="margin-right:auto">Delete</button>` : ''}
      <button type="button" data-close>Cancel</button><button type="submit" class="primary">${existing ? 'Save changes' : 'Create job'}</button></div>`,
  async f => {
    const type = f.get('type');
    const body = { name: f.get('name'), type, source_id: Number(f.get('source_id')), target_id: Number(f.get('target_id')),
      schedule: { kind: type === 'migrate' ? 'manual' : f.get('kind'), every: Number(f.get('every')), time: f.get('time'), weekday: Number(f.get('weekday')) },
      retention: Number(f.get('retention')), enabled: f.get('enabled') === 'on',
      options: { activate_target: f.get('activate_target') === 'on', standby_source: f.get('standby_source') === 'on', files: f.get('files'), keep_sso: f.get('keep_sso') === 'on' } };
    if (existing) await api('PUT', `/api/jobs/${existing.id}`, body); else await api('POST', '/api/jobs', body);
    toast(existing ? 'Job saved' : 'Job created'); route();
  });
  const sync = () => {
    const type = $('input[name=type]', d).value, kind = $('#j-kind', d).value;
    $('#tgt-field', d).hidden = type === 'backup';
    $('#mig-opts', d).hidden = type !== 'migrate';
    $('#files-field', d).hidden = type === 'backup';
    $('#sso-opt', d).hidden = type === 'backup';
    $('#sched-row', d).hidden = type === 'migrate';
    d.querySelectorAll('[data-for]').forEach(el => (el.hidden = !el.dataset.for.split(' ').includes(kind)));
    $('#type-help', d).textContent = TYPE_HELP[type];
  };
  d.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => {
    d.querySelectorAll('[data-type]').forEach(x => x.setAttribute('aria-pressed', x === b));
    $('input[name=type]', d).value = b.dataset.type; sync();
  }));
  $('#j-kind', d).addEventListener('change', sync);
  sync();
}

// ── runs ──
async function viewRuns() {
  const draw = async () => {
    const runs = await api('GET', '/api/runs?limit=100');
    main().innerHTML = `<div class="page-head"><div><h1>Runs</h1><p>Every backup, sync, migration and restore, newest first. Open one to see each step and its log.</p></div></div>${runsTable(runs)}`;
  };
  await draw();
  poll(draw, 5000);
}

async function viewRun(id) {
  let logFrom = 0, logText = '', lastStatus = '';
  const draw = async () => {
    const r = await api('GET', `/api/runs/${id}`);
    const res = r.result || {};
    const live = r.status === 'running' || r.status === 'queued';
    const bSteps = r.steps.filter(s => s.key.startsWith('b.')), rSteps = r.steps.filter(s => s.key.startsWith('r.')), mSteps = r.steps.filter(s => s.key.startsWith('m.'));
    const stepsHtml = (list) => `<ol class="pipeline">${list.map(s => `<li class="${esc(s.status)}">
      <span class="label">${esc(s.label)}</span>${s.started_at && s.finished_at ? `<span class="t">${esc(dur(s.started_at, s.finished_at))}</span>` : s.status === 'running' ? `<span class="t">${esc(dur(s.started_at))}</span>` : ''}
      ${s.detail ? `<div class="detail">${esc(s.detail)}</div>` : ''}</li>`).join('')}</ol>`;
    const cmp = res.comparison;
    const modeNote = res.target_mode === 'standby' ? `<div class="callout standby"><b>${esc(r.target_name)} is in standby.</b> The site is up with the copied data, but it doesn't fetch or send mail, so customers never get duplicates. Promote it with a migration job, or restore a snapshot with “active” mode.</div>`
      : res.target_mode === 'active' ? `<div class="callout"><b>${esc(r.target_name)} is active</b> and now fetches and sends mail.</div>` : '';
    main().innerHTML = `
      <div class="page-head"><div>
        <div class="small muted"><a href="#/runs">Runs</a> / #${r.id}</div>
        <h1>${r.type === 'switch' ? `Turn mail on: ${esc(r.target_name)}` : `${esc(TYPE_LABEL[r.type])}: ${esc(r.source_name ?? (res.snapshot_id ? 'snapshot #' + res.snapshot_id : ''))}${r.target_name ? ' → ' + esc(r.target_name) : ''}`}</h1>
        <p>${runPill(r.status)} <span class="muted small">${r.started_at ? `Started ${esc(fmtDate(r.started_at))}, ${esc(dur(r.started_at, r.finished_at))}` : 'Waiting for the run ahead of it'}${r.job_name ? `, job “${esc(r.job_name)}”` : ''}</span></p></div>
        <div class="actions">${live ? `<button class="danger" data-action="cancel-run" data-id="${r.id}">Cancel run</button>` : ''}
          ${r.job_id && !live ? `<button data-action="run-job" data-id="${r.job_id}">Run this job again</button>` : ''}
          ${res.snapshot_id && !live ? `<a class="btn" href="#/backups">View snapshot</a>` : ''}</div></div>
      ${r.error ? `<div class="callout fail"><b>${r.status === 'cancelled' ? 'Cancelled' : 'Failed'}:</b> ${esc(r.error)}</div>` : ''}
      ${(res.notes || []).map(n => `<div class="callout warn">${esc(n)}</div>`).join('')}
      ${modeNote}
      ${res.kept_sso ? `<div class="callout"><b>SSO kept on ${esc(r.target_name)}.</b> Its own ${fmtNum(res.kept_sso.options)} SSO setting(s)${res.kept_sso.modules ? `, the license rows of ${esc(res.kept_sso.modules)}` : ''}${res.kept_sso.tables ? `, tables ${esc(res.kept_sso.tables)}` : ''} and any SSO folders in storage/app were left as they were; the source's SSO settings were not applied.</div>`
        : res.keep_sso === false ? `<div class="callout warn"><b>SSO was not protected on this run.</b> The source's SSO settings replaced the target's.</div>` : ''}
      ${res.file_scope ? `<div class="callout"><b>${res.file_scope === 'data' ? 'Data-only copy.' : 'Full copy.'}</b> ${res.file_scope === 'data'
        ? `The target kept its own FreeScout code. The source's FreeScout ${esc(res.versions?.source)} database was upgraded to ${esc(res.versions?.target_after ?? res.versions?.target_before)} by FreeScout's migrations.${res.modules ? ` Modules copied: ${esc(res.modules.copied.join(', ') || 'none')}${res.modules.kept_newer_on_target.length ? `; kept on target (same or newer): ${esc(res.modules.kept_newer_on_target.join(', '))}` : ''}.` : ''}`
        : `Application files were copied from the source; the target now runs FreeScout ${esc(res.versions?.target_after ?? res.versions?.source)}.`}
        ${res.db_servers?.source || res.db_servers?.target ? `<div class="small muted" style="margin-top:.35rem">Database servers: ${esc(res.db_servers.source ?? '?')} to ${esc(res.db_servers.target ?? '?')}</div>` : ''}</div>` : ''}
      ${res.checklist ? `<div class="callout"><b>Finish the migration</b><ol>${res.checklist.map(c => `<li>${esc(c)}</li>`).join('')}</ol></div>` : ''}
      <div class="run-grid">
        <div class="panel"><div class="panel-body">
          ${bSteps.length && rSteps.length ? `<p class="phase">Back up ${esc(r.source_name)}</p>${stepsHtml(bSteps)}<p class="phase">Restore onto ${esc(r.target_name)}</p>${stepsHtml(rSteps)}${mSteps.length ? `<p class="phase">Cut-over</p>${stepsHtml(mSteps)}` : ''}`
            : stepsHtml(r.steps)}
        </div></div>
        <div>
          ${cmp ? `<div class="panel" style="margin-bottom:1.25rem"><div class="panel-head"><h3>Row counts, source vs target</h3></div><div class="table-wrap"><table class="cmp">
            <thead><tr><th>Table</th><th>Source (at backup)</th><th>Target (after)</th><th></th></tr></thead><tbody>
            ${cmp.map(c => `<tr><td>${esc(c.table)}</td><td class="num">${fmtNum(c.source)}</td><td class="num">${fmtNum(c.target)}</td>
              <td class="${esc(c.status)}">${c.status === 'match' ? 'Match' : c.status === 'more' ? 'Target has more' : 'Missing rows'}</td></tr>`).join('')}
            </tbody></table></div></div>`
          : res.source_stats ? `<div class="panel" style="margin-bottom:1.25rem"><div class="panel-head"><h3>What was backed up</h3></div><div class="table-wrap"><table>
            <tbody>${Object.entries(res.source_stats).filter(([k]) => !k.startsWith('last_')).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${fmtNum(v)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
          <div class="panel"><div class="panel-head"><h3>Log</h3>${live ? '<span class="pill running">Live</span>' : ''}</div><div class="panel-body"><pre class="log" id="log">${esc(logText) || 'No output yet.'}</pre></div></div>
        </div>
      </div>`;
    const l = await api('GET', `/api/runs/${id}/log?from=${logFrom}`);
    if (l.text && l.next > logFrom) { logText += l.text; logFrom = l.next; }
    const el = $('#log'); if (el) { el.textContent = logText || 'No output yet.'; el.scrollTop = el.scrollHeight; }
    if (!live && lastStatus && lastStatus !== r.status) toast(`Run #${r.id}: ${RUN_LABEL[r.status] || r.status}`, r.status === 'failed');
    lastStatus = r.status;
    if (!live) clearInterval(state.timer);
  };
  await draw();
  poll(draw, 2000);
}

// ── backups ──
async function viewBackups() {
  const insts = await api('GET', '/api/instances');
  const sel = Number(new URLSearchParams(location.hash.split('?')[1]).get('instance')) || 0;
  const snaps = await api('GET', '/api/snapshots' + (sel ? `?instance=${sel}` : ''));
  main().innerHTML = `
    <div class="page-head"><div><h1>Backups</h1><p>Snapshots stored on this manager. Each one has the database, the encryption key and every application file, so any of them can be restored onto any instance.</p></div>
      <div style="min-width:220px"><label for="b-inst" class="small">Instance</label><select id="b-inst"><option value="0">All instances</option>${insts.map(i => `<option value="${i.id}" ${i.id === sel ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select></div></div>
    ${snaps.length ? `<div class="panel table-wrap"><table><thead><tr><th>Taken</th><th>Instance</th><th>FreeScout</th><th>Conversations</th><th>Database</th><th>Files</th><th></th></tr></thead><tbody>
      ${snaps.map(s => `<tr>
        <td class="nowrap"><b title="${esc(fmtDate(s.created_at))}">${esc(fmtDate(s.created_at))}</b><div class="small muted">#${s.id}${s.pinned ? ', pinned' : ''}${s.job_id ? '' : ', manual'}</div></td>
        <td>${esc(s.instance_name)}<div class="small muted">${esc(s.app_url ?? '')}</div></td>
        <td class="num">${esc(s.freescout_version ?? '–')}</td>
        <td class="num">${fmtNum(s.stats?.conversations)}<div class="small muted">${fmtNum(s.stats?.attachments)} attachments</div></td>
        <td class="num">${fmtBytes(s.db_bytes)}</td><td class="num">${fmtBytes(s.files_bytes)}</td>
        <td><div class="actions" style="justify-content:flex-end">
          <button class="small primary" data-action="restore-snap" data-id="${s.id}">Restore</button>
          <a class="btn small" href="/api/snapshots/${s.id}/db.sql.gz" download>Download SQL</a>
          <button class="small" data-action="pin-snap" data-id="${s.id}" data-pinned="${s.pinned ? 1 : 0}">${s.pinned ? 'Unpin' : 'Pin'}</button>
          <button class="small danger" data-action="delete-snap" data-id="${s.id}">Delete</button></div></td>
      </tr>`).join('')}</tbody></table></div>`
    : `<div class="panel empty"><p>No snapshots yet. Back up an instance from the Instances page, or create a backup job.</p><a class="btn" href="#/instances">Go to instances</a></div>`}`;
  $('#b-inst').addEventListener('change', e => (location.hash = '#/backups' + (Number(e.target.value) ? `?instance=${e.target.value}` : '')));
}

async function restoreDialog(snapId) {
  const [insts, snaps] = await Promise.all([api('GET', '/api/instances'), api('GET', '/api/snapshots')]);
  const s = snaps.find(x => x.id === snapId);
  openDialog(`<h2>Restore snapshot #${s.id}</h2>
    <p>${esc(s.instance_name)}, taken ${esc(fmtDate(s.created_at))}, FreeScout ${esc(s.freescout_version)}, ${fmtNum(s.stats?.conversations)} conversations.</p>
    <div class="callout warn">The target's database and application files are replaced with this snapshot. Its <code>.env</code> (URL, database login) is kept, and the agent saves a copy of its current database on the target first.</div>
    <div class="field"><label for="r-tgt">Restore onto</label><select id="r-tgt" name="target_id">${insts.map(i => `<option value="${i.id}" data-name="${esc(i.name)}" ${i.id === s.instance_id ? 'selected' : ''}>${esc(i.name)}${i.id === s.instance_id ? ' (where it came from)' : ''}</option>`).join('')}</select></div>
    <div class="field"><label>After restoring</label>
      <label class="check"><input type="radio" name="mode" value="standby" checked> Leave it in standby: site up, no mail fetched or sent</label>
      <label class="check"><input type="radio" name="mode" value="active"> Make it active: it fetches and sends mail (make sure no other server uses the same mailboxes)</label></div>
    <div class="field"><label for="r-files">What to copy</label><select id="r-files" name="files">
        <option value="auto" ${'auto' === 'auto' ? 'selected' : ''}>Automatic (recommended)</option>
        <option value="data" ${'auto' === 'data' ? 'selected' : ''}>Data only: keep the target's FreeScout version</option>
        <option value="full" ${'auto' === 'full' ? 'selected' : ''}>Everything: exact clone, including the source's FreeScout version</option></select>
      <p class="hint">Snapshot is FreeScout ${esc(s.freescout_version)}. Automatic keeps a newer FreeScout on the target and upgrades the database there.</p></div>
    <label class="check"><input type="checkbox" name="keep_sso" checked> Keep the target's own SSO setup (SAML / OAuth settings, licenses, certificates)</label>
    <div class="field"><label for="r-confirm">Type the target's name to confirm</label><input id="r-confirm" name="confirm" autocomplete="off"></div>
    <div class="foot"><button type="button" data-close>Cancel</button><button type="submit" class="danger solid">Replace target with snapshot</button></div>`,
  async f => {
    const r = await api('POST', `/api/snapshots/${snapId}/restore`, { target_id: Number(f.get('target_id')), mode: f.get('mode'), files: f.get('files'), keep_sso: f.get('keep_sso') === 'on', confirm: f.get('confirm') });
    toast('Restore queued'); location.hash = `#/runs/${r.run_id}`;
  });
}

// ── settings ──
async function viewSettings() {
  state.settings = null;
  const s = await settings();
  main().innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p>How this manager connects to your FreeScout servers.</p></div></div>
    <section class="panel"><div class="panel-head"><h3>Agent install command</h3></div><div class="panel-body">
      <p>Run this on each FreeScout server, as an admin with sudo. Running it again updates the agent to version ${esc(s.agent_version)}.</p>
      <div class="codebox"><code>${esc(s.install_command)}</code><button class="small" data-copy="${esc(s.install_command)}">Copy</button></div>
      <p class="small muted" style="margin-top:.6rem">Options: <code>--dir /var/www/html</code> if FreeScout lives elsewhere; <code>--name b</code> for a second FreeScout on the same server (SSH user becomes <code>fsagent-b</code>).</p>
    </div></section>
    <section class="panel"><div class="panel-head"><h3>Restrict the agent key to this manager's address</h3></div><div class="panel-body">
      <form id="from-form"><div class="field"><label for="s-from">Allowed source IPs (recommended)</label>
        <input id="s-from" name="agent_from" value="${esc(s.agent_from)}" placeholder="e.g. 10.10.20.15 or 10.10.20.0/24">
        <p class="hint">Written into each agent's authorized_keys when you install or update it, so the key is refused from any other address. Leave empty to allow any address.</p></div>
        <button class="primary" type="submit">Save</button></form>
    </div></section>
    <section class="panel"><div class="panel-head"><h3>Manager SSH public key</h3></div><div class="panel-body">
      <p class="small muted">Already built into the install command. Shown here for your records or a manual setup.</p>
      <div class="codebox"><code>${esc(s.public_key)}</code><button class="small" data-copy="${esc(s.public_key)}">Copy</button></div>
    </div></section>
    <section class="panel"><div class="panel-head"><h3>Change your password</h3></div><div class="panel-body">
      <form id="pw-form" style="max-width:380px">
        <div class="field"><label for="pw-c">Current password</label><input id="pw-c" name="current" type="password" autocomplete="current-password"></div>
        <div class="field"><label for="pw-n">New password</label><input id="pw-n" name="password" type="password" autocomplete="new-password" minlength="10"><p class="hint">At least 10 characters.</p></div>
        <button class="primary" type="submit">Change password</button></form>
    </div></section>`;
  $('#from-form').addEventListener('submit', async e => {
    e.preventDefault();
    try { await api('PUT', '/api/settings', { agent_from: new FormData(e.target).get('agent_from') }); state.settings = null; toast('Saved. Re-run the install command on each server to apply it.'); }
    catch (er) { toast(er.message, true); }
  });
  $('#pw-form').addEventListener('submit', async e => {
    e.preventDefault(); const f = new FormData(e.target);
    try { await api('POST', '/api/password', { current: f.get('current'), password: f.get('password') }); e.target.reset(); toast('Password changed'); }
    catch (er) { toast(er.message, true); }
  });
}

// ── actions (event delegation) ──
const actions = {
  async logout() { await api('POST', '/api/logout').catch(() => {}); state.me = null; renderLogin(); },
  'add-instance': () => instanceDialog(),
  async 'edit-instance'(b) { const list = await api('GET', '/api/instances'); instanceDialog(list.find(i => i.id === Number(b.dataset.id))); },
  async 'test-instance'(b) {
    b.disabled = true; b.textContent = 'Checking…';
    try { const r = await api('POST', `/api/instances/${b.dataset.id}/test`); toast(r.ok ? 'Reachable, details updated' : r.error, !r.ok); }
    finally { route(); }
  },
  async 'set-mode'(b) {
    const ok = await confirmDialog(`Turn mail off on ${b.dataset.name}?`,
      'It stops fetching and sending mail (standby). The site stays up so people can still read tickets. To move mail to another server in one step, use "Turn mail on…" on that server instead.', 'Turn mail off', { danger: true });
    if (!ok) return;
    await api('POST', `/api/instances/${b.dataset.id}/mode`, { mode: 'standby' });
    toast(`Mail is off on ${b.dataset.name}`); route();
  },
  'mail-on': b => mailOnDialog(Number(b.dataset.id)),
  async 'backup-instance'(b) { const r = await api('POST', `/api/instances/${b.dataset.id}/backup`); toast('Backup queued'); location.hash = `#/runs/${r.run_id}`; },
  async 'delete-instance'(b) {
    b.closest('dialog')?.close();
    if (await confirmDialog('Delete this instance?', 'Its jobs are deleted too. Snapshots already taken stay on this manager until you delete them.', 'Delete instance')) {
      await api('DELETE', `/api/instances/${b.dataset.id}`); toast('Instance deleted'); route();
    }
  },
  async 'reset-hostkey'(b) { await api('POST', `/api/instances/${b.dataset.id}/reset-hostkey`); toast('Host key forgotten. The next connection records the new one.'); },
  'add-job': () => jobDialog(),
  async 'edit-job'(b) { const jobs = await api('GET', '/api/jobs'); jobDialog(jobs.find(j => j.id === Number(b.dataset.id))); },
  async 'delete-job'(b) {
    b.closest('dialog')?.close();
    if (await confirmDialog('Delete this job?', 'Past runs and snapshots are kept.', 'Delete job')) { await api('DELETE', `/api/jobs/${b.dataset.id}`); toast('Job deleted'); route(); }
  },
  async 'run-job'(b) { const r = await api('POST', `/api/jobs/${b.dataset.id}/run`); toast('Job queued'); location.hash = `#/runs/${r.run_id}`; },
  async 'cancel-run'(b) {
    if (await confirmDialog('Cancel this run?', 'If it is part-way through restoring, the target is left in maintenance mode and the run page says how to roll it back.', 'Cancel run')) {
      await api('POST', `/api/runs/${b.dataset.id}/cancel`); toast('Cancelling…');
    }
  },
  'restore-snap': b => restoreDialog(Number(b.dataset.id)),
  async 'pin-snap'(b) { await api('POST', `/api/snapshots/${b.dataset.id}/pin`, { pinned: b.dataset.pinned !== '1' }); route(); },
  async 'delete-snap'(b) {
    if (await confirmDialog('Delete this snapshot?', 'This permanently removes its database dump and files from the manager.', 'Delete snapshot')) {
      await api('DELETE', `/api/snapshots/${b.dataset.id}`); toast('Snapshot deleted'); route();
    }
  },
};
document.addEventListener('click', async e => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    e.preventDefault();
    try { await navigator.clipboard.writeText(copy.dataset.copy); toast('Copied'); }
    catch { const r = document.createRange(); r.selectNodeContents(copy.previousElementSibling); getSelection().removeAllRanges(); getSelection().addRange(r); toast('Selected. Press Ctrl+C to copy.'); }
    return;
  }
  const row = e.target.closest('tr[data-href]');
  if (row && !e.target.closest('a,button')) { location.hash = row.dataset.href; return; }
  const b = e.target.closest('[data-action]');
  if (!b || !actions[b.dataset.action]) return;
  e.preventDefault();
  try { await actions[b.dataset.action](b); } catch (er) { if (er.message !== 'Signed out') toast(er.message, true); }
});

route();
