'use strict';
/* E-day phone bank: admin page. Vanilla JS. All data is rendered with textContent / createElement. */
(function () {
if (window.top !== window.self) { document.documentElement.style.display = 'none'; return; }  // no framing

// ---------- tiny DOM helpers ----------
const $ = (id) => document.getElementById(id);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function setMsg(el, text, kind) {
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

function buildTable(tbl, headers, rows, numCols) {
  const nums = new Set(numCols || []);
  const thead = h('thead', null, h('tr', null, ...headers.map((t, i) => h('th', { class: nums.has(i) ? 'num' : null, text: t }))));
  const tbody = h('tbody');
  for (const r of rows) {
    const tr = h('tr', { class: r.cls || null });
    (r.cells || r).forEach((c, i) => tr.append(h('td', { class: nums.has(i) ? 'num' : null }, c)));
    tbody.append(tr);
  }
  tbody.append(...[]);
  tbl.replaceChildren(thead, tbody);
  return tbody;
}

function emptyRow(tbl, text) {
  tbl.replaceChildren(h('tbody', null, h('tr', null, h('td', { class: 'muted', text }))));
}

// ---------- time (America/New_York) ----------
const TZ = 'America/New_York';
const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
const fmtDateTime = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
const fmtHM = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
const fmtParts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function toDate(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}
function etTime(iso) { const d = toDate(iso); return d ? fmtTime.format(d) + ' ET' : '-'; }
function etDateTime(iso) { const d = toDate(iso); return d ? fmtDateTime.format(d) + ' ET' : '-'; }
function etHM(iso) { const d = toDate(iso); return d ? fmtHM.format(d) : '-'; }
function stamp(iso) { // YYYYMMDD-HHMM in ET
  const d = toDate(iso) || new Date();
  const p = {};
  for (const x of fmtParts.formatToParts(d)) p[x.type] = x.value;
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}`;
}
function mmss(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// ---------- state ----------
const cfgApp = window.APP_CONFIG || {};
let TOKEN = null;
let lastStats = null;
let cfg = {};            // last known server config
let timer = null;
let inflight = false;
let tick = 0;

class AuthError extends Error {}

// ---------- RPC ----------
async function rpc(fn, args) {
  let res;
  try {
    res = await fetch(`${cfgApp.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: cfgApp.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {}),
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch (e) {
    throw new Error('Network error: could not reach the server.');
  }
  if (res.status !== 200) throw new Error(`Server error (HTTP ${res.status}).`);
  let json;
  try { json = await res.json(); } catch (e) { throw new Error('Bad response from server.'); }
  return json;
}

async function call(fn, args) {
  const body = Object.assign({ p_admin: TOKEN }, args || {});
  const res = await rpc(fn, body);
  if (res && res.status === 'unauthorized') {
    showInvalid('This admin link is not valid.');
    throw new AuthError('unauthorized');
  }
  return res;
}
function needOk(res) {
  if (!res || res.status !== 'ok') throw new Error((res && res.message) || `Unexpected status: ${res && res.status}`);
  return res;
}

// Run an action with the button disabled and errors shown inline.
async function run(btn, msgEl, fn) {
  const btns = Array.isArray(btn) ? btn : [btn];
  btns.forEach((b) => { if (b) b.disabled = true; });
  if (msgEl) setMsg(msgEl, '', '');
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof AuthError) && msgEl) setMsg(msgEl, e.message || String(e), 'err');
    return undefined;
  } finally {
    btns.forEach((b) => { if (b) b.disabled = false; });
  }
}

function showInvalid(text) {
  if (timer) { clearInterval(timer); timer = null; }
  try { sessionStorage.removeItem('admin_token'); } catch (e) { /* ignore */ }
  TOKEN = null;
  $('app').hidden = true;
  const g = $('gate');
  g.textContent = text;
  g.hidden = false;
}

// ---------- file download ----------
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}

// ---------- 1. Dashboard ----------
const OUTCOME_LABELS = {
  no_answer: 'No answer', busy: 'Busy', left_voicemail: 'Left voicemail', wrong_number: 'Wrong number',
  disconnected: 'Disconnected', do_not_call: 'Do not call', talked_will_vote: 'Talked: will vote',
  talked_already_voted: 'Talked: already voted', talked_refused: 'Talked: refused', call_back: 'Not available, call back',
  moved: 'Moved', deceased: 'Deceased', language_spanish: 'Language: Spanish', language_other: 'Language: Other',
  answered: 'Answered',
  moved_household: 'Moved (no one here)',
  talked_not_voting: 'Talked: not voting',
};
const OUTCOME_ORDER = Object.keys(OUTCOME_LABELS);

function card(k, v, cls) {
  return h('div', { class: 'card' + (cls ? ' ' + cls : '') }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: String(v) }));
}

function barRows(container, items) {
  const max = Math.max(1, ...items.map((i) => i.n));
  container.replaceChildren(...items.map((i) => {
    const span = h('span');
    span.style.width = (100 * i.n / max).toFixed(1) + '%';
    return h('div', { class: 'bar-row' }, h('div', { text: i.label }), h('div', { class: 'bar' }, span), h('div', { class: 'n', text: String(i.n) }));
  }));
  if (!items.length) container.replaceChildren(h('div', { class: 'muted small', text: 'None yet.' }));
}

function renderStats(s) {
  lastStats = s;
  // banner
  const open = !!s.calling_open;
  const banner = $('banner');
  banner.className = 'banner ' + (open ? 'open' : 'closed');
  $('banner-text').textContent = open ? 'CALLING IS OPEN' : 'CALLING IS CLOSED';
  const bb = $('banner-btn');
  bb.textContent = open ? 'Close calling' : 'Open calling...';
  bb.className = open ? 'danger' : '';
  if (!bb.dataset.busy) bb.disabled = false;
  // data kind
  const kind = String(s.data_kind || 'empty');
  const kb = $('kind-badge');
  kb.className = 'badge kind-' + (['synthetic', 'real', 'empty'].includes(kind) ? kind : 'empty');
  kb.textContent = kind === 'synthetic' ? 'SYNTHETIC DATA (test only, not real voters)'
    : kind === 'real' ? 'REAL DATA' : kind === 'empty' ? 'NO DATA LOADED' : 'data: ' + kind;
  $('server-now').textContent = s.now ? 'Server time ' + etTime(s.now) : '';

  // cards
  const v = s.voters || {};
  const conflicts = Number(s.conflicts) || 0;
  const unexported = Number(s.unexported) || 0;
  $('cards').replaceChildren(
    card('Calls total', s.calls_total ?? 0),
    card('Volunteers active (15 min)', s.volunteers_active_15min ?? 0),
    card('Voters open', v.open ?? 0),
    card('Voters reached', v.reached ?? 0),
    card('Voters suppressed', v.suppressed ?? 0),
    card('Unexported results', unexported, unexported > 0 ? 'attn' : ''),
    card('Conflicts', conflicts, conflicts > 0 ? 'alert' : ''),
  );

  // households table
  const hh = s.households || {};
  const cols = ['ready', 'ready_eligible', 'claimed', 'done', 'exhausted', 'total'];
  buildTable($('tbl-households'), ['Pool', ...cols],
    ['main', 'vbm'].filter((p) => hh[p]).map((p) => [p, ...cols.map((c) => String(hh[p][c] ?? 0))]),
    [1, 2, 3, 4, 5, 6]);

  buildTable($('tbl-voters'), ['open', 'reached', 'suppressed', 'total'],
    [[v.open ?? 0, v.reached ?? 0, v.suppressed ?? 0, v.total ?? 0].map(String)], [0, 1, 2, 3]);

  const ne = s.next_eligible_at || {};
  buildTable($('tbl-next'), ['Pool', 'Next retry eligible'],
    ['main', 'vbm'].map((p) => [p, ne[p] ? etDateTime(ne[p]) : 'none pending']));

  // attempts histogram
  const hist = s.attempts_hist || {};
  const keys = Object.keys(hist).sort((a, b) => Number(a) - Number(b));
  barRows($('hist'), keys.map((k) => ({ label: k + (k === '1' ? ' attempt' : ' attempts'), n: Number(hist[k]) || 0 })));

  // outcomes
  const oc = s.outcomes || {};
  const ocKeys = Object.keys(oc).sort((a, b) => {
    const ia = OUTCOME_ORDER.indexOf(a), ib = OUTCOME_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const SUPPORT_ORDER = ['strong_support', 'lean_support', 'undecided', 'lean_against', 'strong_against'];
  const SUPPORT_LABELS = { strong_support: 'Strong support', lean_support: 'Lean support', undecided: 'Undecided', lean_against: 'Lean against', strong_against: 'Strong against' };
  const sup = s.support || {};
  const supRows = SUPPORT_ORDER.filter((k) => sup[k]).map((k) => ['Support: ' + SUPPORT_LABELS[k], String(sup[k])]);
  if (ocKeys.length) buildTable($('tbl-outcomes'), ['Outcome', 'Count'], ocKeys.map((k) => [OUTCOME_LABELS[k] || k, String(oc[k])]).concat(supRows), [1]);
  else emptyRow($('tbl-outcomes'), 'No results yet.');

  // calls per 15 minutes (newest first)
  const buckets = (s.calls_per_15min || []).slice().sort((a, b) => String(b.bucket).localeCompare(String(a.bucket)));
  barRows($('per15'), buckets.map((b) => ({ label: etHM(b.bucket), n: Number(b.n) || 0 })));
}

function renderClaims(c) {
  const tbl = $('tbl-claims');
  const claims = c.claims || [];
  if (!claims.length) { emptyRow(tbl, 'No live claims.'); return; }
  buildTable(tbl, ['Phone', 'Pool', 'Volunteer', 'Age (m:ss)', 'Dialed', ''],
    claims.map((cl) => {
      const btn = h('button', { type: 'button', class: 'secondary', text: 'Release' });
      btn.addEventListener('click', () => releaseClaim(cl, btn));
      return [cl.phone, cl.pool, cl.volunteer_name || '', mmss(cl.age_seconds), cl.dialed ? 'yes' : 'no', btn];
    }), [3]);
}

async function releaseClaim(cl, btn) {
  const text = `Release the household on ${cl.phone} (held by ${cl.volunteer_name || 'unknown'})?\n\n`
    + (cl.dialed
      ? 'They already dialed: this counts as an attempt and the retry delay applies.'
      : 'They have not dialed yet: it goes back to the queue with no attempt counted.');
  if (!window.confirm(text)) return;
  const msg = $('claims-msg');
  await run(btn, msg, async () => {
    const res = await call('admin_release', { p_phone: cl.phone });
    needOk(res);
    setMsg(msg, `Released ${cl.phone}. Household status: ${res.household_status || 'updated'}.`, 'ok');
    await refresh(true);
  });
}

async function refresh(force) {
  if (inflight && !force) return;
  if (!TOKEN) return;
  inflight = true;
  try {
    const [s, c] = await Promise.all([call('admin_stats'), call('admin_claims')]);
    needOk(s); needOk(c);
    renderStats(s);
    renderClaims(c);
    setMsg($('dash-status'), 'Updated ' + etTime(new Date().toISOString()) + ' (refreshes every 5 s)', '');
    tick++;
    if (tick % 4 === 0) loadVolunteers(true);
    if ($('audit-details').open) loadAudit();
  } catch (e) {
    if (!(e instanceof AuthError)) setMsg($('dash-status'), 'Connection problem, showing old numbers. Retrying. (' + e.message + ')', 'err');
  } finally {
    inflight = false;
  }
}

// calling toggle
function setupCallingToggle() {
  const btn = $('banner-btn');
  const panel = $('open-panel');
  const inp = $('open-input');
  const confirmBtn = $('open-confirm');
  const msg = $('open-msg');

  btn.addEventListener('click', async () => {
    if (!lastStats) return;
    if (lastStats.calling_open) {
      if (!window.confirm('Close calling? Volunteers who hold a household can still finish and submit it.')) return;
      btn.dataset.busy = '1';
      await run(btn, $('dash-status'), async () => {
        needOk(await call('admin_config_set', { p_key: 'calling_open', p_value: false }));
        await refresh(true);
      });
      delete btn.dataset.busy;
      btn.disabled = false;
    } else {
      const warns = [];
      if (lastStats.data_kind === 'synthetic') warns.push('The loaded data is SYNTHETIC test data, not the real call lists.');
      if (lastStats.data_kind === 'empty') warns.push('No data is loaded. Volunteers will get nothing to call.');
      if (!(cfg.scripts && (cfg.scripts.main_default || '').trim())) warns.push('The main default script looks empty or settings are not loaded.');
      if (!warns.length) warns.push('Check that scripts, retry policy and the paid-for-by line are final.');
      $('open-warnings').replaceChildren(...warns.map((w) => h('li', { text: w })));
      inp.value = '';
      confirmBtn.disabled = true;
      setMsg(msg, '', '');
      panel.hidden = false;
      inp.focus();
    }
  });
  inp.addEventListener('input', () => { confirmBtn.disabled = inp.value.trim() !== 'OPEN'; });
  $('open-cancel').addEventListener('click', () => { panel.hidden = true; inp.value = ''; });
  confirmBtn.addEventListener('click', async () => {
    if (inp.value.trim() !== 'OPEN') return;
    await run([confirmBtn, $('open-cancel')], msg, async () => {
      needOk(await call('admin_config_set', { p_key: 'calling_open', p_value: true }));
      panel.hidden = true;
      inp.value = '';
      await refresh(true);
    });
    confirmBtn.disabled = inp.value.trim() !== 'OPEN';
  });
}

// ---------- 3. Requeue ----------
function setupRequeue() {
  $('requeue-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('rq-msg');
    const btn = ev.target.querySelector('button[type=submit]');
    let phone = $('rq-phone').value.replace(/\D/g, '');
    if (phone.length === 11 && phone[0] === '1') phone = phone.slice(1);
    const reason = $('rq-reason').value.trim();
    if (phone.length !== 10) { setMsg(msg, 'Enter a 10-digit phone number.', 'err'); return; }
    if (!reason) { setMsg(msg, 'A reason is required.', 'err'); return; }
    await run(btn, msg, async () => {
      needOk(await call('admin_requeue', { p_phone: phone, p_reason: reason }));
      setMsg(msg, 'Requeued ' + phone + '.', 'ok');
      $('rq-phone').value = '';
      $('rq-reason').value = '';
      refresh(true);
    });
  });
}

// ---------- 4. Volunteers ----------
function volLink(token) {
  return `${location.origin}${location.pathname.replace(/admin\.html$/, '')}index.html#t=${token}`;
}

function setupVolunteers() {
  $('vol-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('vol-msg');
    const btn = ev.target.querySelector('button[type=submit]');
    const name = $('vol-name').value.trim();
    if (!name) { setMsg(msg, 'Name is required.', 'err'); return; }
    await run(btn, msg, async () => {
      const res = needOk(await call('admin_volunteer_create', { p_name: name, p_pool: $('vol-pool').value }));
      $('vol-link').value = volLink(res.token);
      $('vol-link-title').textContent = 'Personal link for ' + name + ' (' + $('vol-pool').value + ' pool)';
      $('vol-link-box').hidden = false;
      setMsg($('vol-copy-msg'), '', '');
      $('vol-name').value = '';
      setMsg(msg, 'Created.', 'ok');
      $('vol-link').focus();
      $('vol-link').select();
      loadVolunteers(true);
    });
  });
  $('vol-copy').addEventListener('click', async () => {
    const inp = $('vol-link');
    const m = $('vol-copy-msg');
    try {
      await navigator.clipboard.writeText(inp.value);
      setMsg(m, 'Copied.', 'ok');
    } catch (e) {
      inp.focus(); inp.select();
      let okc = false;
      try { okc = document.execCommand('copy'); } catch (e2) { /* ignore */ }
      setMsg(m, okc ? 'Copied.' : 'Copy failed: select the text and copy it by hand.', okc ? 'ok' : 'err');
    }
  });
  $('vol-link-done').addEventListener('click', () => {
    $('vol-link').value = '';
    $('vol-link-box').hidden = true;
  });
  $('vol-refresh').addEventListener('click', (ev) => run(ev.target, $('vol-list-msg'), () => loadVolunteers(false)));
}

async function loadVolunteers(silent) {
  const tbl = $('tbl-vols');
  // do not clobber a select the user is interacting with
  if (silent && tbl.contains(document.activeElement)) return;
  try {
    const res = needOk(await call('admin_volunteers'));
    renderVolunteers(res.volunteers || []);
    if (!silent) setMsg($('vol-list-msg'), '', '');
  } catch (e) {
    if (e instanceof AuthError) return;
    if (!silent) throw e;
  }
}

function renderVolunteers(vols) {
  const tbl = $('tbl-vols');
  if (!vols.length) { emptyRow(tbl, 'No volunteers yet.'); return; }
  const msg = $('vol-list-msg');
  // Ranked: most calls today first (ties: active first, then name).
  const ranked = vols.slice().sort((a, b) =>
    (Number(b.calls_today) || 0) - (Number(a.calls_today) || 0) || (b.active === a.active ? 0 : b.active ? 1 : -1) ||
    String(a.name).localeCompare(String(b.name)));
  const rows = ranked.map((v, i) => {
    const sel = h('select', { 'aria-label': 'Pool for ' + v.name },
      h('option', { value: 'main', text: 'main' }), h('option', { value: 'vbm', text: 'vbm' }));
    sel.value = v.pool;
    sel.addEventListener('change', async () => {
      const newPool = sel.value;
      await run(sel, msg, async () => {
        try {
          needOk(await call('admin_volunteer_update', { p_id: v.id, p_pool: newPool, p_active: null }));
          setMsg(msg, `${v.name}: pool set to ${newPool}.`, 'ok');
          v.pool = newPool;
        } catch (e) { sel.value = v.pool; throw e; }
      });
    });
    const toggle = h('button', { type: 'button', class: v.active ? 'secondary' : '', text: v.active ? 'Revoke' : 'Reactivate' });
    toggle.addEventListener('click', async () => {
      if (v.active && !window.confirm(`Revoke ${v.name}? Their link stops working on their next action. If they hold a household, release it under Live claims.`)) return;
      await run(toggle, msg, async () => {
        needOk(await call('admin_volunteer_update', { p_id: v.id, p_pool: null, p_active: !v.active }));
        setMsg(msg, `${v.name}: ${v.active ? 'revoked' : 'reactivated'}.`, 'ok');
        await loadVolunteers(false);
      });
    });
    return {
      cls: v.active ? null : 'revoked',
      cells: [String(i + 1), v.name, sel, v.active ? 'Active' : 'Revoked', v.last_seen_at ? etDateTime(v.last_seen_at) : 'never',
        String(v.calls_today ?? 0), v.has_claim ? 'yes' : 'no', toggle],
    };
  });
  buildTable(tbl, ['#', 'Name', 'Pool', 'Status', 'Last seen', 'Calls today', 'Has claim', ''], rows, [0, 5]);
}

// ---------- 5. Config ----------
const SCRIPT_KEYS = ['main_default', 'vbm_default', 'main_HD37', 'main_HD39', 'vbm_HD37', 'vbm_HD39',
  'main_HD39_SD15', 'main_HD37_SD17', 'main_HD35_SD17', 'vbm_HD39_SD15', 'vbm_HD37_SD17', 'vbm_HD35_SD17'];
const SAMPLE = { voter_first: 'Ana', volunteer_first: 'Sam', polling_place: 'Oviedo City Hall', polling_address: '400 Alexandria Blvd, Oviedo' };
const inputs = {};       // key -> input element (for simple fields)
const labelInputs = {};  // SD10/HD37/HD39
const scriptInputs = {}; // script key -> textarea

function updatePaidWarn() {
  $('paid-warn').hidden = true;   // "Paid for by" is optional (campaign decision, Nov 3)
}

function field(label, help) {
  const box = h('div', { class: 'field' }, h('div', { class: 'lab', text: label }));
  if (help) box.append(h('div', { class: 'help', text: help }));
  return box;
}

async function saveKey(key, value, btn, msg, onDone) {
  await run(btn, msg, async () => {
    needOk(await call('admin_config_set', { p_key: key, p_value: value }));
    cfg[key] = value;
    setMsg(msg, 'Saved ' + etTime(new Date().toISOString()), 'ok');
    if (onDone) onDone();
  });
}

function simpleField(key, label, help, kind) {
  const box = field(label + '  (' + key + ')', help);
  let input;
  if (kind === 'bool') input = h('input', { type: 'checkbox' });
  else if (kind === 'textarea') input = h('textarea', { rows: 6 });
  else if (kind === 'json') input = h('textarea', { rows: 14, spellcheck: 'false' });
  else if (kind === 'int' || kind === 'num') input = h('input', { type: 'number', step: kind === 'int' ? '1' : 'any', min: '0' });
  else input = h('input', { type: 'text', size: 40, autocomplete: 'off' });
  inputs[key] = input;
  const btn = h('button', { type: 'button', text: 'Save' });
  const msg = h('span', { class: 'msg' });
  btn.addEventListener('click', async () => {
    let value;
    try {
      if (kind === 'bool') value = input.checked;
      else if (kind === 'int' || kind === 'num') {
        if (input.value.trim() === '') throw new Error('Enter a number.');
        value = Number(input.value);
        if (!isFinite(value)) throw new Error('Not a number.');
        if (kind === 'int' && !Number.isInteger(value)) throw new Error('Must be a whole number.');
        if (key === 'max_attempts' && value < 1) throw new Error('Must be at least 1.');
        if (key !== 'max_attempts' && value <= 0 && key !== 'van_contact_type_id') throw new Error('Must be greater than 0.');
      } else if (kind === 'intnull') {
        const t = input.value.trim();
        value = t === '' ? null : Number(t);
        if (value !== null && (!Number.isInteger(value) || value <= 0)) throw new Error('Must be a positive whole number, or blank.');
      } else if (kind === 'json') {
        value = JSON.parse(input.value);
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Must be a JSON object.');
      } else value = input.value;
    } catch (e) {
      setMsg(msg, key === 'result_map' && e instanceof SyntaxError ? 'Invalid JSON: ' + e.message : e.message, 'err');
      return;
    }
    await saveKey(key, value, btn, msg, key === 'paid_for_by' ? updatePaidWarn : null);
  });
  const controls = h('div', { class: 'controls' }, input, btn, msg);
  box.append(controls);
  return box;
}

function buildConfigUI() {
  const root = $('cfg-fields');
  const parts = [];

  const paid = simpleField('paid_for_by', 'Paid for by', 'Optional. If set, shown to callers as a reminder and substituted for {paid_for_by} in scripts. Leave blank if not used.', 'text');
  parts.push(paid);

  // race labels
  const rl = field('Race badge labels  (race_labels)', 'Text shown on the badges for SD 10, HD 37 and HD 39.');
  const rlControls = h('div', { class: 'controls' });
  for (const k of ['SD10', 'HD37', 'HD39']) {
    const inp = h('input', { type: 'text', size: 18, autocomplete: 'off' });
    labelInputs[k] = inp;
    rlControls.append(h('label', null, k, inp));
  }
  const rlBtn = h('button', { type: 'button', text: 'Save' });
  const rlMsg = h('span', { class: 'msg' });
  rlBtn.addEventListener('click', () => {
    const value = {};
    for (const k of ['SD10', 'HD37', 'HD39']) value[k] = labelInputs[k].value.trim();
    if (Object.values(value).some((x) => !x)) { setMsg(rlMsg, 'All three labels are required.', 'err'); return; }
    saveKey('race_labels', value, rlBtn, rlMsg);
  });
  rlControls.append(rlBtn, rlMsg);
  rl.append(rlControls);
  parts.push(rl);

  // scripts
  const sc = field('Scripts  (scripts)', 'Placeholders: {voter_first} {volunteer_first} {polling_place} {polling_address} {paid_for_by}. A blank HD-specific script falls back to the pool default. Each box saves on its own.');
  for (const k of SCRIPT_KEYS) {
    const ta = h('textarea', { rows: 6 });
    scriptInputs[k] = ta;
    ta.addEventListener('input', updatePreview);
    const btn = h('button', { type: 'button', text: 'Save' });
    const msg = h('span', { class: 'msg' });
    btn.addEventListener('click', () => {
      const value = {};
      for (const kk of SCRIPT_KEYS) value[kk] = typeof (cfg.scripts || {})[kk] === 'string' ? cfg.scripts[kk] : '';
      value[k] = ta.value;
      saveKey('scripts', value, btn, msg, updatePreview);
    });
    sc.append(h('div', { class: 'sub' }, h('div', { class: 'lab2', text: k }), h('div', { class: 'controls' }, ta, btn, msg)));
  }
  parts.push(sc);

  parts.push(simpleField('vbm_instructions', 'Mail-ballot instructions', 'Shown to callers on the vbm pool.', 'textarea'));
  parts.push(simpleField('max_attempts', 'Max attempts per household', 'Whole number, at least 1.', 'int'));
  parts.push(simpleField('retry_delay_minutes', 'Retry delay (minutes)', 'Wait before a household can be called again.', 'num'));
  parts.push(simpleField('claim_lease_minutes', 'Claim lease (minutes)', 'How long a volunteer holds a household before dialing.', 'num'));
  parts.push(simpleField('dialed_lease_minutes', 'Dialed lease (minutes)', 'How long a volunteer has to submit after dialing.', 'num'));
  parts.push(simpleField('left_message_is_final', 'Left voicemail is final', 'If checked, a voicemail closes the voter (no retry).', 'bool'));
  parts.push(simpleField('export_date_format', 'Export date format', 'Postgres to_char pattern, e.g. MM/DD/YYYY.', 'text'));
  parts.push(simpleField('van_contact_type_id', 'VAN contact type ID', 'Whole number. Phone = 1.', 'int'));
  parts.push(simpleField('first_pass_across_lists', 'First pass across both lists', 'On: when a caller\'s own list has no first calls left, they get first calls from the other list before any retries. Off: callers stay on their own list (retries after their list\'s first pass).', 'bool'));
  parts.push(simpleField('support_label', 'Support rating label', 'Shown to callers above the support buttons (only for people they talked to).', 'text'));
  parts.push(simpleField('support_survey_question_id', 'VAN survey question ID for support', 'Blank until the VAN survey question is chosen. Exported as SurveyQuestionID on rows with a support rating.', 'intnull'));
  parts.push(simpleField('support_map', 'Support options (JSON)', 'The 5 support levels: label shown to callers and van_response_id (VAN survey response ID, or null).', 'json'));
  parts.push(simpleField('result_map', 'Result map (JSON)', 'Outcome code to VAN result code mapping. Validated as JSON before saving.', 'json'));

  root.replaceChildren(...parts);

  // preview select
  $('pv-select').replaceChildren(...SCRIPT_KEYS.map((k) => h('option', { value: k, text: k })));
  $('pv-select').addEventListener('change', updatePreview);
  inputs.paid_for_by.addEventListener('input', updatePreview);
}

function fillConfigUI() {
  const setVal = (k, kind) => {
    const v = cfg[k];
    const el = inputs[k];
    if (!el) return;
    if (kind === 'bool') el.checked = !!v;
    else if (kind === 'json') el.value = v === undefined ? '' : JSON.stringify(v, null, 2);
    else el.value = v === undefined || v === null ? '' : String(v);
  };
  setVal('paid_for_by'); setVal('vbm_instructions'); setVal('max_attempts'); setVal('retry_delay_minutes');
  setVal('claim_lease_minutes'); setVal('dialed_lease_minutes'); setVal('left_message_is_final', 'bool');
  setVal('export_date_format'); setVal('van_contact_type_id'); setVal('result_map', 'json');
  setVal('support_label'); setVal('support_survey_question_id'); setVal('support_map', 'json');
  setVal('first_pass_across_lists', 'bool');
  const rl = cfg.race_labels || {};
  for (const k of ['SD10', 'HD37', 'HD39']) labelInputs[k].value = typeof rl[k] === 'string' ? rl[k] : '';
  const sc = cfg.scripts || {};
  for (const k of SCRIPT_KEYS) scriptInputs[k].value = typeof sc[k] === 'string' ? sc[k] : '';
  updatePaidWarn();
  updatePreview();
}

async function loadConfig() {
  const res = needOk(await call('admin_config_get'));
  cfg = res.config || {};
  fillConfigUI();
}

function updatePreview() {
  const key = $('pv-select').value || SCRIPT_KEYS[0];
  const notes = [];
  let text = scriptInputs[key] ? scriptInputs[key].value : '';
  if (!text.trim() && key.indexOf('_default') < 0) {
    const fb = key.split('_')[0] + '_default';
    notes.push(`${key} is blank, so volunteers will see ${fb}.`);
    text = scriptInputs[fb] ? scriptInputs[fb].value : '';
  }
  if (!text.trim()) notes.push('This script is empty.');
  const paid = inputs.paid_for_by ? inputs.paid_for_by.value.trim() : '';
  const values = Object.assign({}, SAMPLE, { paid_for_by: paid });
  let out = text;
  for (const [k, v] of Object.entries(values)) out = out.split('{' + k + '}').join(v);
  const unknown = Array.from(new Set((text.match(/\{[^{}\s]*\}/g) || []).filter((m) => !(m.slice(1, -1) in values))));
  if (unknown.length) notes.push('Unknown placeholders (will not be replaced): ' + unknown.join(' '));
  $('pv-out').textContent = out;
  $('pv-notes').replaceChildren(...notes.map((n) => h('div', { class: 'warn-text', text: n })));
}

// ---------- 6. Suppression ----------
const sup = { vanids: [], previewed: false };

function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function parseVanids(text) {
  text = text.replace(/^﻿/, '');
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim() !== '');
  if (!lines.length) throw new Error('The file is empty.');
  const first = parseCsvLine(lines[0]);
  let col = first.findIndex((c) => /^(voter file )?vanid$/i.test(c.replace(/^﻿/, '')));
  let start = 1;
  if (col < 0) {
    if (first.length === 1 && /^\d+$/.test(first[0])) { col = 0; start = 0; }
    else throw new Error('No VANID column found. The first row must have a VANID header, or the file must be one column of numbers.');
  }
  const set = new Set();
  let rows = 0, invalid = 0;
  for (let i = start; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const raw = (cells[col] || '').trim();
    rows++;
    if (/^\d+$/.test(raw)) set.add(String(BigInt(raw))); // normalizes leading zeros
    else invalid++;
  }
  return { vanids: Array.from(set), rows, invalid, dupes: rows - invalid - set.size };
}

function setupSuppression() {
  const fileEl = $('sup-file'), reasonEl = $('sup-reason');
  const previewBtn = $('sup-preview'), confirmBtn = $('sup-confirm');
  const parsedEl = $('sup-parsed');

  const resetPreview = () => {
    sup.previewed = false;
    $('sup-result').hidden = true;
    $('sup-force').checked = false;
    setMsg($('sup-msg2'), '', '');
  };
  const updateButtons = () => { previewBtn.disabled = !(sup.vanids.length && reasonEl.value.trim()); };

  fileEl.addEventListener('change', async () => {
    resetPreview();
    sup.vanids = [];
    parsedEl.textContent = '';
    setMsg($('sup-msg'), '', '');
    const f = fileEl.files && fileEl.files[0];
    if (!f) { updateButtons(); return; }
    try {
      const p = parseVanids(await f.text());
      sup.vanids = p.vanids;
      if (!p.vanids.length) throw new Error('No valid VANIDs found in the file.');
      parsedEl.textContent = `${p.vanids.length.toLocaleString()} unique VANIDs parsed from ${p.rows.toLocaleString()} rows`
        + (p.dupes ? `, ${p.dupes.toLocaleString()} duplicates removed` : '')
        + (p.invalid ? `, ${p.invalid.toLocaleString()} rows skipped (not a number)` : '') + '.';
    } catch (e) {
      sup.vanids = [];
      setMsg($('sup-msg'), e.message, 'err');
    }
    updateButtons();
  });
  reasonEl.addEventListener('input', () => { resetPreview(); updateButtons(); });

  const updateConfirm = () => {
    const cap = $('sup-cap').hidden === false;
    confirmBtn.disabled = !sup.previewed || (cap && !$('sup-force').checked);
  };
  $('sup-force').addEventListener('change', updateConfirm);

  previewBtn.addEventListener('click', async () => {
    const msg = $('sup-msg');
    resetPreview();
    await run(previewBtn, msg, async () => {
      const res = await call('admin_suppress', { p_vanids: sup.vanids, p_reason: reasonEl.value.trim(), p_force: false, p_dry_run: true });
      if (res.status !== 'ok' && res.status !== 'refused') throw new Error(res.message || 'Preview failed: ' + res.status);
      showSupResult(res, 'Dry run: nothing changed yet.');
      sup.previewed = true;
      $('sup-cap').hidden = !res.would_exceed_cap;
      updateConfirm();
    });
  });

  confirmBtn.addEventListener('click', async () => {
    const msg = $('sup-msg2');
    if (!window.confirm(`Suppress up to ${sup.vanids.length.toLocaleString()} uploaded VANIDs? Suppressed voters will not be called.`)) return;
    await run([confirmBtn, previewBtn], msg, async () => {
      const res = await call('admin_suppress', {
        p_vanids: sup.vanids, p_reason: reasonEl.value.trim(),
        p_force: !$('sup-cap').hidden && $('sup-force').checked, p_dry_run: false,
      });
      if (res.status === 'refused') throw new Error('Refused: this would suppress more than 25% of open voters. Tick "Force" to override.');
      if (res.status !== 'ok') throw new Error(res.message || 'Failed: ' + res.status);
      showSupResult(res, 'DONE: suppression applied.');
      sup.previewed = false;
      setMsg(msg, `Suppressed ${res.matched} voters.`, 'ok');
      refresh(true);
    });
    updateConfirm();
  });
}

function showSupResult(res, note) {
  $('sup-result').hidden = false;
  buildTable($('tbl-sup'), ['Result', 'Count'], [
    ['Matched (open voters to suppress)', String(res.matched)],
    ['Already closed', String(res.already_closed)],
    ['Not found', String(res.not_found)],
    ['Open voters before', String(res.open_before)],
    ['Would exceed 25% cap', res.would_exceed_cap ? 'YES' : 'no'],
  ], [1]);
  setMsg($('sup-msg2'), note, '');
}

// ---------- 7. Export ----------
const EXPORT_COLS = ['VANID', 'ResultCodeID', 'ResultCode', 'ContactTypeID', 'DateCanvassed', 'PhoneNumber', 'Outcome', 'Volunteer', 'Support', 'SurveyQuestionID', 'SurveyResponseID'];

function csvField(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // block spreadsheet formula injection
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function rowsToCsv(rows) {
  const lines = [EXPORT_COLS.join(',')];
  for (const r of rows) lines.push(EXPORT_COLS.map((c) => csvField(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}
function downloadBatch(res) {
  const name = `van_results_batch_${res.batch}_${stamp(res.created_at)}.csv`;
  downloadText(name, rowsToCsv(res.rows || []), 'text/csv;charset=utf-8');
  return name;
}

async function loadBatches() {
  const res = needOk(await call('admin_export_batches'));
  const tbl = $('tbl-batches');
  const batches = res.batches || [];
  if (!batches.length) { emptyRow(tbl, 'No batches yet.'); return; }
  buildTable(tbl, ['Batch', 'Created', 'By', 'Rows', ''], batches.map((b) => {
    const btn = h('button', { type: 'button', class: 'secondary', text: 'Download again' });
    btn.addEventListener('click', () => run(btn, $('exp-msg'), async () => {
      const r = needOk(await call('admin_export_batch', { p_batch: b.batch }));
      const name = downloadBatch(r);
      setMsg($('exp-msg'), `Downloaded ${name} (${(r.rows || []).length} rows).`, 'ok');
    }));
    return [String(b.batch), etDateTime(b.created_at), b.created_by || '', String(b.row_count ?? ''), btn];
  }), [0, 3]);
}

function setupExport() {
  $('exp-new').addEventListener('click', (ev) => run(ev.target, $('exp-msg'), async () => {
    const res = await call('admin_export_new_batch');
    if (res.status === 'empty') { setMsg($('exp-msg'), 'No new results.', ''); return; }
    needOk(res);
    const name = downloadBatch(res);
    setMsg($('exp-msg'), `Batch ${res.batch}: downloaded ${name} (${(res.rows || []).length} rows). Upload it to VAN.`, 'ok');
    await loadBatches();
    refresh(true);
  }));
  $('exp-refresh').addEventListener('click', (ev) => run(ev.target, $('exp-msg'), loadBatches));
}

// ---------- 8. Backup ----------
function setupBackup() {
  $('bk-btn').addEventListener('click', (ev) => run(ev.target, $('bk-msg'), async () => {
    const res = needOk(await call('admin_backup'));
    const name = `phonebank_backup_${stamp(res.taken_at)}.json`;
    downloadText(name, JSON.stringify(res), 'application/json');
    setMsg($('bk-msg'), `Downloaded ${name}: ${(res.call_log || []).length} calls, ${(res.voters || []).length} voters, ${(res.households || []).length} households.`, 'ok');
  }));
}

// ---------- 9. Audit ----------
async function loadAudit() {
  const msg = $('audit-msg');
  try {
    const res = needOk(await call('admin_audit', { p_limit: 50 }));
    const entries = res.entries || [];
    const tbl = $('tbl-audit');
    if (!entries.length) { emptyRow(tbl, 'No entries.'); return; }
    const tbody = buildTable(tbl, ['Time', 'Actor', 'Action', 'Detail'], entries.map((e) => [
      etDateTime(e.at), typeof e.actor === 'string' ? e.actor : JSON.stringify(e.actor), String(e.action),
      h('span', { text: JSON.stringify(e.detail) }),
    ]));
    tbody.querySelectorAll('tr').forEach((tr) => { tr.lastChild.className = 'detail'; });
    setMsg(msg, '', '');
  } catch (e) {
    if (!(e instanceof AuthError)) setMsg(msg, e.message, 'err');
  }
}

function setupAudit() {
  $('audit-details').addEventListener('toggle', () => { if ($('audit-details').open) loadAudit(); });
  $('audit-refresh').addEventListener('click', (ev) => run(ev.target, $('audit-msg'), loadAudit));
}

// ---------- init ----------
async function init() {
  if (!cfgApp.SUPABASE_URL || !cfgApp.SUPABASE_ANON_KEY) {
    const g = $('gate');
    g.textContent = 'config.js is missing or incomplete.';
    g.hidden = false;
    return;
  }
  // token: fragment first (then strip it), else sessionStorage
  const m = /(?:^|[#&])a=([^&]+)/.exec(location.hash || '');
  if (m) {
    TOKEN = decodeURIComponent(m[1]).trim();
    try { sessionStorage.setItem('admin_token', TOKEN); } catch (e) { /* ignore */ }
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  } else {
    try { TOKEN = sessionStorage.getItem('admin_token'); } catch (e) { TOKEN = null; }
  }
  if (!TOKEN) { showInvalid('This admin link is not valid.'); return; }

  let who;
  try {
    who = await call('admin_whoami');
  } catch (e) {
    if (e instanceof AuthError) return;
    const g = $('gate');
    g.textContent = 'Could not reach the server to verify the admin link (' + e.message + ') Reload to try again.';
    g.hidden = false;
    return;
  }
  if (who.status !== 'ok') { showInvalid('This admin link is not valid.'); return; }

  $('whoami').textContent = 'Signed in as ' + (who.name || 'admin');
  $('app').hidden = false;

  buildConfigUI();
  setupCallingToggle();
  setupRequeue();
  setupVolunteers();
  setupSuppression();
  setupExport();
  setupBackup();
  setupAudit();
  $('cfg-reload').addEventListener('click', (ev) => run(ev.target, $('cfg-msg'), async () => {
    await loadConfig();
    setMsg($('cfg-msg'), 'Reloaded.', 'ok');
  }));

  // initial loads (config first so the open-calling warnings know paid_for_by)
  await run(null, $('cfg-msg'), loadConfig);
  loadVolunteers(false).catch((e) => setMsg($('vol-list-msg'), e.message, 'err'));
  loadBatches().catch((e) => setMsg($('exp-msg'), e.message, 'err'));
  await refresh(true);

  timer = setInterval(() => { if (!document.hidden) refresh(false); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
}

init();
})();
