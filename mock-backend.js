/* DEMO ONLY: an in-browser stand-in for the Supabase backend of the E-day phone bank.
 *
 * It replaces window.fetch for ".../rest/v1/rpc/<fn>" calls and answers them from
 * synthetic data (demo-data.js), following the contract in e-day-phones/app/API.md.
 * Nothing leaves the browser: the page's CSP is connect-src 'none'.
 * State is kept in localStorage (shared by index.html and admin.html), so the admin
 * dashboard updates as you record calls on the volunteer page.
 *
 * Links:  index.html#t=demo-caller   (volunteer, main list)
 *         index.html#t=demo-vbm      (volunteer, mail-ballot list)
 *         admin.html#a=demo-admin    (admin)
 * Add ?clean to a URL to hide the "Demo" pill (for screenshots).
 */
(function () {
  'use strict';
  var KEY = 'pbdemo_state_v1';
  var MIN = 60000;
  var D = window.DEMO_DATA;

  /* ---------- deterministic random for the seed ---------- */
  function rng(seed) { return function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
  function hex(n, r) { var s = ''; for (var i = 0; i < n; i++) s += Math.floor(r() * 16).toString(16); return s; }
  function iso(ms) { return new Date(ms).toISOString(); }
  function now() { return Date.now(); }

  /* ---------- config (mirrors app/sql defaults; demo text, no real names) ---------- */
  var RESULT_MAP = {
    no_answer: { label: 'No answer', scope: 'household', voter_status: 'open', final: false, van_code: 1, van_name: 'Not Home' },
    busy: { label: 'Busy', scope: 'household', voter_status: 'open', final: false, van_code: 18, van_name: 'Busy' },
    left_voicemail: { label: 'Left voicemail', scope: 'household', voter_status: 'open', final: false, van_code: 19, van_name: 'Left Message' },
    wrong_number: { label: 'Wrong number', scope: 'household', voter_status: 'suppressed', final: true, van_code: 20, van_name: 'Wrong Number' },
    disconnected: { label: 'Disconnected', scope: 'household', voter_status: 'suppressed', final: true, van_code: 25, van_name: 'Disconnected' },
    do_not_call: { label: 'Do not call', scope: 'household', voter_status: 'suppressed', final: true, van_code: 22, van_name: 'Do Not Call' },
    moved_household: { label: 'Moved (no one here)', scope: 'household', voter_status: 'suppressed', final: true, van_code: 5, van_name: 'Moved' },
    talked_will_vote: { label: 'Talked: will vote', scope: 'voter', voter_status: 'reached', final: false, van_code: 14, van_name: 'Canvassed' },
    talked_already_voted: { label: 'Talked: already voted', scope: 'voter', voter_status: 'suppressed', final: false, van_code: 14, van_name: 'Canvassed' },
    talked_refused: { label: 'Talked: refused', scope: 'voter', voter_status: 'suppressed', final: false, van_code: 2, van_name: 'Refused' },
    talked_not_voting: { label: 'Talked: not voting', scope: 'voter', voter_status: 'suppressed', final: false, van_code: 14, van_name: 'Canvassed' },
    call_back: { label: 'Not available, call back', scope: 'voter', voter_status: 'open', final: false, van_code: 17, van_name: 'Call Back' },
    moved: { label: 'Moved', scope: 'voter', voter_status: 'suppressed', final: false, van_code: 5, van_name: 'Moved' },
    deceased: { label: 'Deceased', scope: 'voter', voter_status: 'suppressed', final: false, van_code: 4, van_name: 'Deceased' },
    language_spanish: { label: 'Language: Spanish', scope: 'voter', voter_status: 'open', final: false, van_code: 6, van_name: 'Spanish' },
    language_other: { label: 'Language: Other', scope: 'voter', voter_status: 'open', final: false, van_code: 31, van_name: 'Other Language' }
  };
  var SUPPORT_MAP = {
    strong_support: { label: 'Strong support', van_response_id: null },
    lean_support: { label: 'Lean support', van_response_id: null },
    undecided: { label: 'Undecided', van_response_id: null },
    lean_against: { label: 'Lean against', van_response_id: null },
    strong_against: { label: 'Strong against', van_response_id: null }
  };
  function defaultConfig() {
    var c = baseConfig(), live = (D && D.live) || {};
    // Volunteer-facing settings as they were live on E-day (see demo-data.js). Max attempts stays 3
    // (live until 3:52 PM ET) so the retry flow can be shown; data_kind stays "synthetic" because it is.
    Object.keys(live).forEach(function (k) { c[k] = live[k]; });
    return c;
  }
  function baseConfig() {
    return {
      calling_open: true,
      max_attempts: 3,
      retry_delay_minutes: 60,
      claim_lease_minutes: 5,
      dialed_lease_minutes: 30,
      left_message_is_final: false,
      first_pass_across_lists: true,
      paid_for_by: 'Example Democratic Committee (demo)',
      race_labels: { SD10: 'SD 10', HD37: 'HD 37', HD39: 'HD 39' },
      scripts: {
        main_default: "Hi, is this {voter_first}? My name is {volunteer_first}, and I'm a volunteer. Today is Election Day!\n\nYour polling place is {polling_place}, {polling_address}. Polls are open until 7 PM.\n\nCan we count on you to vote today?",
        vbm_default: "Hi, is this {voter_first}? My name is {volunteer_first}, and I'm a volunteer. Our records show your mail ballot hasn't been received yet. It must be RECEIVED by 7 PM today, so it is too late to mail it.\n\nThe easiest option: bring it to your polling place, {polling_place}, {polling_address}. They will cancel it and you vote in person.",
        main_HD37: '', main_HD39: '', vbm_HD37: '', vbm_HD39: '',
        main_HD39_SD15: '', main_HD37_SD17: '', main_HD35_SD17: '', vbm_HD39_SD15: '', vbm_HD37_SD17: '', vbm_HD35_SD17: ''
      },
      vbm_instructions: ' Must be RECEIVED by 7 PM today. Do not mail it. Bring it to the polling place (it gets canceled and they vote in person).',
      result_map: RESULT_MAP,
      support_label: 'How likely are they to support us?',
      support_survey_question_id: null,
      support_map: SUPPORT_MAP,
      claim_limit_per_10min: 25,
      release_limit_per_hour: 10,
      van_contact_type_id: 1,
      export_date_format: 'MM/DD/YYYY',
      data_kind: 'synthetic'
    };
  }

  /* ---------- state ---------- */
  var S = null, memOnly = false;
  function load() {
    try { var raw = window.localStorage.getItem(KEY); if (raw) return JSON.parse(raw); } catch (e) { memOnly = true; }
    return null;
  }
  function save() {
    if (memOnly) return;
    try { window.localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { memOnly = true; }
  }

  function buildFresh() {
    var t0 = now();
    var r = rng(20261103);
    var st = {
      created: t0, config: defaultConfig(), households: {}, order: [], voters: {}, byPhone: {},
      volunteers: [], admins: [{ token: 'demo-admin', name: 'Demo admin' }],
      claims: {}, call_log: [], voter_results: [], batches: [], audit: [], results_seen: {}
    };
    D.households.forEach(function (h) {
      st.households[h[0]] = { phone: h[0], pool: h[1], call_order: h[2], status: 'ready', attempts: 0, next_eligible_at: 0 };
      st.order.push(h[0]); st.byPhone[h[0]] = [];
    });
    D.voters.forEach(function (row) {
      var v = {}; D.voter_cols.forEach(function (c, i) { v[c] = row[i]; });
      v.status = 'open'; v.status_reason = null; v.status_at = null;
      st.voters[v.vanid] = v; st.byPhone[v.phone].push(v.vanid);
    });
    Object.keys(st.byPhone).forEach(function (p) {
      st.byPhone[p].sort(function (a, b) { return Number(st.voters[a].source_call_order) - Number(st.voters[b].source_call_order); });
    });
    st.order.sort(function (a, b) { return st.households[a].call_order - st.households[b].call_order; });

    // Fictional volunteers. The first two are the presenter's links.
    var vols = [
      ['demo-caller', 'Jordan (you)', 'main', true],
      ['demo-vbm', 'Riley (you, mail-ballot list)', 'vbm', true],
      [null, 'Priya S.', 'main', true], [null, 'Marcus T.', 'main', true], [null, 'Elena R.', 'main', true],
      [null, 'Dev K.', 'main', true], [null, 'Aisha B.', 'vbm', true], [null, 'Sam W.', 'main', false]
    ];
    vols.forEach(function (x, i) {
      st.volunteers.push({ id: 'vol-' + (i + 1) + '-' + hex(8, r), token: x[0] || hex(32, r), name: x[1], pool: x[2], active: x[3],
        created_at: iso(t0 - (240 - i * 5) * MIN), last_seen_at: null });
    });
    S = st;

    // Seed a realistic afternoon: ~150 dials spread over the last 3.5 hours, shaped like the real E-day mix.
    var callers = st.volunteers.slice(2, 7);
    var mix = [['no_answer', 44], ['left_voicemail', 35], ['disconnected', 8], ['wrong_number', 4], ['do_not_call', 2], ['busy', 1], ['answered', 6]];
    function pick() { var x = r() * 100, a = 0; for (var i = 0; i < mix.length; i++) { a += mix[i][1]; if (x < a) return mix[i][0]; } return 'no_answer'; }
    var start = t0 - 210 * MIN, n = 150;
    var mainQ = st.order.filter(function (p) { return st.households[p].pool === 'main'; });
    var vbmQ = st.order.filter(function (p) { return st.households[p].pool === 'vbm'; });
    var mi = 0, vi = 0;
    for (var k = 0; k < n; k++) {
      var at = start + Math.floor((k / n) * 200 * MIN + r() * 60000);
      var vol = callers[Math.floor(r() * callers.length)];
      var phone;
      if (vol.pool === 'vbm') { phone = vbmQ[vi++]; } else { phone = mainQ[mi++]; }
      if (!phone) continue;
      var ho = pick(), vo = [];
      if (ho === 'answered') {
        vo = S.byPhone[phone].map(function (vid) {
          var y = r(), oc = y < 0.4 ? 'talked_will_vote' : y < 0.75 ? 'talked_already_voted' : y < 0.9 ? 'talked_refused' : 'call_back';
          var o = { vanid: vid, outcome: oc };
          if (/^talked_/.test(oc) && oc !== 'talked_refused' && r() < 0.6) o.support = r() < 0.6 ? 'strong_support' : 'lean_support';
          return o;
        });
      }
      applyResult(vol, phone, ho, vo, null, 'seed-' + k, at);
      var prev = vol.last_seen_at ? Date.parse(vol.last_seen_at) : 0;
      vol.last_seen_at = iso(Math.max(prev, at));
    }
    // A first export batch made an hour ago.
    makeBatch(st.admins[0].name, t0 - 60 * MIN);
    // Two volunteers are mid-call right now.
    [[callers[0], 1, false], [callers[1], 3, true]].forEach(function (c) {
      var p = mainQ[mi++]; if (!p) return;
      var cl = newClaim(c[0], p, t0 - c[1] * MIN);
      if (c[2]) { cl.dialed = true; cl.dialed_at = t0 - (c[1] - 1) * MIN; cl.lease = t0 + 30 * MIN; }
      c[0].last_seen_at = iso(t0 - 20000);
    });
    // Sam W. was revoked; Aisha's last activity is recent.
    audit('Demo admin', 'config_set', { key: 'calling_open', value: true }, start - 5 * MIN);
    audit('Demo admin', 'volunteer_update', { name: 'Sam W.', active: false }, t0 - 90 * MIN);
    audit('Demo admin', 'export_new_batch', { batch: 1 }, t0 - 60 * MIN);
    save();
  }

  /* ---------- core logic ---------- */
  function audit(actor, action, detail, at) { S.audit.push({ id: S.audit.length + 1, at: iso(at || now()), actor: actor, action: action, detail: detail }); }
  function openVoters(phone) { return (S.byPhone[phone] || []).filter(function (id) { return S.voters[id].status === 'open'; }); }
  function volBy(tok) { for (var i = 0; i < S.volunteers.length; i++) if (S.volunteers[i].token === tok) return S.volunteers[i]; return null; }
  function volById(id) { for (var i = 0; i < S.volunteers.length; i++) if (S.volunteers[i].id === id) return S.volunteers[i]; return null; }
  function claimOf(vol) { for (var k in S.claims) if (S.claims[k].vol_id === vol.id) return S.claims[k]; return null; }
  function claimByPhone(phone) { for (var k in S.claims) if (S.claims[k].phone === phone) return S.claims[k]; return null; }
  function newClaim(vol, phone, at) {
    var tok = 'c' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
    var c = { claim_token: tok, phone: phone, vol_id: vol.id, claimed_at: at, dialed: false, dialed_at: null,
      lease: at + S.config.claim_lease_minutes * MIN };
    S.claims[tok] = c; S.households[phone].status = 'claimed';
    return c;
  }
  function afterAttempt(hh, at) {
    hh.attempts += 1;
    if (!openVoters(hh.phone).length) { hh.status = 'done'; return; }
    if (hh.attempts >= S.config.max_attempts) { hh.status = 'exhausted'; return; }
    hh.status = 'ready'; hh.next_eligible_at = at + S.config.retry_delay_minutes * MIN;
  }
  function sweep() {
    var t = now();
    Object.keys(S.claims).forEach(function (k) {
      var c = S.claims[k];
      if (c.lease > t) return;
      var hh = S.households[c.phone];
      delete S.claims[k];
      if (c.dialed) afterAttempt(hh, t); else hh.status = 'ready';
    });
  }
  function setVoter(vid, status, reason, at) { var v = S.voters[vid]; v.status = status; v.status_reason = reason; v.status_at = iso(at); }

  function applyResult(vol, phone, ho, vo, note, resultId, at) {
    var hh = S.households[phone];
    var call = { id: S.call_log.length + 1, result_id: resultId, at: iso(at), volunteer_id: vol.id, volunteer: vol.name,
      phone: phone, household_outcome: ho, note: note || null };
    S.call_log.push(call);
    var rm = S.config.result_map;
    var lmFinal = !!S.config.left_message_is_final;
    if (ho !== 'answered') {
      var m = rm[ho];
      openVoters(phone).forEach(function (vid) {
        var stt = m.voter_status;
        if (ho === 'left_voicemail' && lmFinal) stt = 'suppressed';
        S.voter_results.push({ vanid: vid, phone: phone, outcome: ho, support: null, at: iso(at), volunteer: vol.name, call_id: call.id, batch: null });
        if (stt !== 'open') setVoter(vid, stt, ho, at);
      });
      if (m.final) { hh.attempts += 1; hh.status = 'done'; } else afterAttempt(hh, at);
    } else {
      vo.forEach(function (o) {
        var m2 = rm[o.outcome];
        var sup = (/^talked_/.test(o.outcome) && o.support && SUPPORT_MAP[o.support]) ? o.support : null;
        S.voter_results.push({ vanid: o.vanid, phone: phone, outcome: o.outcome, support: sup, at: iso(at), volunteer: vol.name, call_id: call.id, batch: null });
        if (m2.voter_status !== 'open') setVoter(o.vanid, m2.voter_status, o.outcome, at);
      });
      afterAttempt(hh, at);
    }
    S.results_seen[resultId] = hh.status;
    return hh.status;
  }

  function claimNext(vol) {
    var t = now(), cfg = S.config;
    function cands(pool, firstPass) {
      return S.order.filter(function (p) {
        var hh = S.households[p];
        var sk = hh.skipped && hh.skipped[vol.id];
        if (sk && t - sk < 30 * MIN) return false;
        return hh.pool === pool && hh.status === 'ready' && hh.next_eligible_at <= t && openVoters(p).length &&
          (firstPass ? hh.attempts === 0 : hh.attempts > 0);
      });
    }
    var other = vol.pool === 'main' ? 'vbm' : 'main';
    var list = cands(vol.pool, true);
    if (!list.length && cfg.first_pass_across_lists) list = cands(other, true);
    if (!list.length) list = cands(vol.pool, false).sort(function (a, b) { return S.households[a].next_eligible_at - S.households[b].next_eligible_at; });
    return list[0] || null;
  }
  function nextEligible(pool) {
    var t = now(), best = null;
    S.order.forEach(function (p) {
      var hh = S.households[p];
      if (hh.pool !== pool || hh.status !== 'ready' || hh.next_eligible_at <= t || !openVoters(p).length) return;
      if (best === null || hh.next_eligible_at < best) best = hh.next_eligible_at;
    });
    return best === null ? null : iso(best);
  }
  function claimPayload(c) {
    var hh = S.households[c.phone];
    var first = S.voters[S.byPhone[c.phone][0]];
    return {
      status: 'ok',
      claim: { claim_token: c.claim_token, phone: c.phone, phone_type: first ? first.phone_type : '', pool: hh.pool,
        attempts: hh.attempts, dialed: c.dialed, lease_expires_at: iso(c.lease) },
      voters: openVoters(c.phone).map(function (vid) {
        var v = S.voters[vid];
        return { vanid: v.vanid, first_name: v.first_name, last_name: v.last_name, hd: v.hd, sd: v.sd, tier: v.tier,
          voted_primary26: v.voted_primary26, vbm: v.vbm, polling_name: v.polling_name, polling_address: v.polling_address,
          county: v.county, precinct: v.precinct };
      })
    };
  }
  function etDate(ms) {
    var p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    return p.month + '/' + p.day + '/' + p.year;
  }
  function exportRow(vr) {
    var m = S.config.result_map[vr.outcome] || {};
    var sm = vr.support ? S.config.support_map[vr.support] : null;
    return { VANID: vr.vanid, ResultCodeID: m.van_code, ResultCode: m.van_name, ContactTypeID: S.config.van_contact_type_id,
      DateCanvassed: etDate(Date.parse(vr.at)), PhoneNumber: vr.phone, Outcome: m.label || vr.outcome, Volunteer: vr.volunteer,
      Support: sm ? sm.label : '', SurveyQuestionID: sm ? S.config.support_survey_question_id : null,
      SurveyResponseID: sm ? sm.van_response_id : null };
  }
  function makeBatch(by, at) {
    var rows = S.voter_results.filter(function (x) { return x.batch === null && Date.parse(x.at) <= at; });
    if (!rows.length) return null;
    var b = { batch: S.batches.length + 1, created_at: iso(at), created_by: by, row_count: rows.length };
    rows.forEach(function (x) { x.batch = b.batch; });
    S.batches.push(b);
    return b;
  }
  function batchPayload(b) {
    return { status: 'ok', batch: b.batch, created_at: b.created_at,
      rows: S.voter_results.filter(function (x) { return x.batch === b.batch; }).map(exportRow) };
  }

  /* ---------- RPC handlers ---------- */
  var VOL = {
    vol_me: function (a, vol) {
      var c = S.config;
      return { status: 'ok', name: vol.name, pool: vol.pool, calling_open: !!c.calling_open, calls_today: callsToday(vol),
        content: { paid_for_by: c.paid_for_by, race_labels: c.race_labels, scripts: c.scripts, vbm_instructions: c.vbm_instructions,
          support_label: c.support_label,
          support_options: Object.keys(c.support_map).map(function (k) { return { code: k, label: c.support_map[k].label }; }) } };
    },
    vol_claim_next: function (a, vol) {
      var held = claimOf(vol);
      if (held) return claimPayload(held);
      if (!S.config.calling_open) return { status: 'closed' };
      var p = claimNext(vol);
      if (!p) return { status: 'empty', next_eligible_at: nextEligible(vol.pool) };
      return claimPayload(newClaim(vol, p, now()));
    },
    vol_heartbeat: function (a, vol) {
      var c = S.claims[a.p_claim_token];
      if (!c || c.vol_id !== vol.id) return { status: 'lost' };
      c.lease = Math.max(c.lease, now() + (c.dialed ? S.config.dialed_lease_minutes : S.config.claim_lease_minutes) * MIN);
      return { status: 'ok', lease_expires_at: iso(c.lease) };
    },
    vol_mark_dialed: function (a, vol) {
      var c = S.claims[a.p_claim_token];
      if (!c || c.vol_id !== vol.id) return { status: 'lost' };
      if (!c.dialed && !S.config.calling_open) return { status: 'closed' };
      if (!c.dialed) { c.dialed = true; c.dialed_at = now(); c.lease = now() + S.config.dialed_lease_minutes * MIN; }
      return { status: 'ok' };
    },
    vol_release: function (a, vol) {
      var c = S.claims[a.p_claim_token];
      if (!c || c.vol_id !== vol.id) return { status: 'lost' };
      if (c.dialed) return { status: 'dialed' };
      delete S.claims[a.p_claim_token];
      var rh = S.households[c.phone];
      rh.status = 'ready';
      rh.skipped = rh.skipped || {}; rh.skipped[vol.id] = now();   // this volunteer won't get it back for a while
      return { status: 'ok' };
    },
    vol_submit: function (a, vol) {
      if (S.results_seen[a.p_result_id]) return { status: 'ok', applied: 'replay', household_status: S.results_seen[a.p_result_id] };
      var c = S.claims[a.p_claim_token];
      if (!c || c.vol_id !== vol.id) return { status: 'error', message: 'This call is no longer held.' };
      if (!c.dialed) return { status: 'error', message: 'This call was never dialed.' };
      var ho = a.p_household_outcome, vo = a.p_voter_outcomes || [];
      if (ho !== 'answered' && !S.config.result_map[ho]) return { status: 'error', message: 'Unknown outcome.' };
      if (ho === 'answered') {
        var mine = S.byPhone[c.phone];
        for (var i = 0; i < vo.length; i++) {
          if (mine.indexOf(String(vo[i].vanid)) < 0) return { status: 'error', message: 'Voter not on this household.' };
          if (!S.config.result_map[vo[i].outcome] || S.config.result_map[vo[i].outcome].scope !== 'voter') return { status: 'error', message: 'Unknown outcome.' };
        }
      }
      delete S.claims[a.p_claim_token];
      var hs = applyResult(vol, c.phone, ho, vo, a.p_note, a.p_result_id, now());
      return { status: 'ok', applied: 'live', household_status: hs };
    }
  };
  function callsToday(vol) { return S.call_log.filter(function (c) { return c.volunteer_id === vol.id; }).length; }

  var ADMIN = {
    admin_whoami: function (a, ad) { return { status: 'ok', name: ad.name }; },
    admin_stats: function () {
      var t = now(), hh = { main: {}, vbm: {} };
      ['main', 'vbm'].forEach(function (p) { hh[p] = { ready: 0, ready_eligible: 0, claimed: 0, done: 0, exhausted: 0, total: 0 }; });
      var hist = {};
      S.order.forEach(function (p) {
        var h = S.households[p], o = hh[h.pool];
        o.total++; o[h.status]++;
        if (h.status === 'ready' && h.next_eligible_at <= t && openVoters(p).length) o.ready_eligible++;
        hist[h.attempts] = (hist[h.attempts] || 0) + 1;
      });
      var v = { open: 0, reached: 0, suppressed: 0, total: 0 };
      Object.keys(S.voters).forEach(function (k) { v[S.voters[k].status]++; v.total++; });
      var oc = {}, sup = {};
      S.call_log.forEach(function (c) { if (c.household_outcome !== 'answered') oc[c.household_outcome] = (oc[c.household_outcome] || 0) + 1; });
      S.voter_results.forEach(function (x) {
        if (S.config.result_map[x.outcome] && S.config.result_map[x.outcome].scope === 'voter') oc[x.outcome] = (oc[x.outcome] || 0) + 1;
        if (x.support) sup[x.support] = (sup[x.support] || 0) + 1;
      });
      var buckets = {};
      S.call_log.forEach(function (c) {
        var ms = Date.parse(c.at); var b = ms - (ms % (15 * MIN));
        buckets[b] = (buckets[b] || 0) + 1;
      });
      var active = S.volunteers.filter(function (x) { return x.active && x.last_seen_at && t - Date.parse(x.last_seen_at) < 15 * MIN; }).length;
      return { status: 'ok', now: iso(t), calling_open: !!S.config.calling_open, data_kind: S.config.data_kind,
        households: hh, voters: v, attempts_hist: hist, outcomes: oc, support: sup,
        calls_per_15min: Object.keys(buckets).map(function (b) { return { bucket: iso(Number(b)), n: buckets[b] }; }),
        calls_total: S.call_log.length, conflicts: 0,
        unexported: S.voter_results.filter(function (x) { return x.batch === null; }).length,
        volunteers_active_15min: active, next_eligible_at: { main: nextEligible('main'), vbm: nextEligible('vbm') } };
    },
    admin_claims: function () {
      var t = now();
      return { status: 'ok', claims: Object.keys(S.claims).map(function (k) {
        var c = S.claims[k], vol = volById(c.vol_id) || {};
        return { phone: c.phone, pool: S.households[c.phone].pool, volunteer_id: c.vol_id, volunteer_name: vol.name,
          claimed_at: iso(c.claimed_at), age_seconds: Math.round((t - c.claimed_at) / 1000), dialed: c.dialed,
          dialed_at: c.dialed_at ? iso(c.dialed_at) : null, lease_expires_at: iso(c.lease) };
      }) };
    },
    admin_release: function (a, ad) {
      var c = claimByPhone(String(a.p_phone));
      if (!c) return { status: 'error', message: 'No live claim on that phone.' };
      delete S.claims[c.claim_token];
      var hh = S.households[c.phone];
      if (c.dialed) afterAttempt(hh, now()); else hh.status = 'ready';
      audit(ad.name, 'release', { phone: c.phone });
      return { status: 'ok', household_status: hh.status };
    },
    admin_requeue: function (a, ad) {
      var hh = S.households[String(a.p_phone)];
      if (!hh) return { status: 'error', message: 'Phone not found.' };
      if (hh.status === 'claimed') return { status: 'error', message: 'That household is claimed right now.' };
      if (!openVoters(hh.phone).length) return { status: 'error', message: 'No open voters on that phone.' };
      hh.status = 'ready'; hh.next_eligible_at = 0;
      audit(ad.name, 'requeue', { phone: hh.phone, reason: a.p_reason });
      return { status: 'ok' };
    },
    admin_volunteers: function () {
      var t = now();
      return { status: 'ok', volunteers: S.volunteers.map(function (v) {
        return { id: v.id, name: v.name, pool: v.pool, active: v.active, created_at: v.created_at, last_seen_at: v.last_seen_at,
          calls_today: callsToday(v), has_claim: !!claimOf(v),
          claims_last_hour: S.call_log.filter(function (c) { return c.volunteer_id === v.id && t - Date.parse(c.at) < 60 * MIN; }).length,
          skips_last_hour: 0 };
      }) };
    },
    admin_volunteer_create: function (a, ad) {
      var name = String(a.p_name || '').trim();
      if (!name) return { status: 'error', message: 'Name is required.' };
      var r = rng(now() & 0xffffffff);
      var v = { id: 'vol-' + (S.volunteers.length + 1) + '-' + hex(8, r), token: hex(32, r), name: name,
        pool: a.p_pool === 'vbm' ? 'vbm' : 'main', active: true, created_at: iso(now()), last_seen_at: null };
      S.volunteers.push(v);
      audit(ad.name, 'volunteer_create', { name: name, pool: v.pool });
      return { status: 'ok', id: v.id, token: v.token };
    },
    admin_volunteer_update: function (a, ad) {
      var v = volById(a.p_id);
      if (!v) return { status: 'error', message: 'Unknown volunteer.' };
      if (a.p_pool === 'main' || a.p_pool === 'vbm') v.pool = a.p_pool;
      if (a.p_active === true || a.p_active === false) v.active = a.p_active;
      audit(ad.name, 'volunteer_update', { name: v.name, pool: v.pool, active: v.active });
      return { status: 'ok' };
    },
    admin_config_get: function () { return { status: 'ok', config: JSON.parse(JSON.stringify(S.config)) }; },
    admin_config_set: function (a, ad) {
      if (!(a.p_key in S.config) || a.p_key === 'data_kind') return { status: 'error', message: 'Unknown or read-only key.' };
      S.config[a.p_key] = a.p_value;
      audit(ad.name, 'config_set', { key: a.p_key });
      return { status: 'ok' };
    },
    admin_suppress: function (a, ad) {
      var ids = (a.p_vanids || []).map(String), matched = [], closed = 0, nf = 0;
      var openBefore = Object.keys(S.voters).filter(function (k) { return S.voters[k].status === 'open'; }).length;
      ids.forEach(function (id) {
        var v = S.voters[id];
        if (!v) nf++; else if (v.status !== 'open') closed++; else matched.push(id);
      });
      var cap = matched.length > 0.25 * openBefore;
      var res = { dry_run: !!a.p_dry_run, matched: matched.length, already_closed: closed, not_found: nf, open_before: openBefore, would_exceed_cap: cap };
      if (cap && !a.p_force && !a.p_dry_run) { res.status = 'refused'; return res; }
      if (!a.p_dry_run) {
        matched.forEach(function (id) { setVoter(id, 'suppressed', 'upload: ' + a.p_reason, now()); });
        audit(ad.name, 'suppress', { matched: matched.length, reason: a.p_reason });
      }
      res.status = cap && !a.p_force ? 'refused' : 'ok';
      if (a.p_dry_run) res.status = 'ok';
      return res;
    },
    admin_export_new_batch: function (a, ad) {
      var b = makeBatch(ad.name, now());
      if (!b) return { status: 'empty' };
      audit(ad.name, 'export_new_batch', { batch: b.batch, rows: b.row_count });
      return batchPayload(b);
    },
    admin_export_batch: function (a) {
      var b = S.batches[Number(a.p_batch) - 1];
      return b ? batchPayload(b) : { status: 'error', message: 'No such batch.' };
    },
    admin_export_batches: function () { return { status: 'ok', batches: S.batches.slice().reverse() }; },
    admin_backup: function () {
      return { status: 'ok', taken_at: iso(now()), call_log: S.call_log, voter_results: S.voter_results,
        households: S.order.map(function (p) { return S.households[p]; }),
        voters: Object.keys(S.voters).map(function (k) { var v = S.voters[k]; return { vanid: v.vanid, phone: v.phone, status: v.status, status_reason: v.status_reason, status_at: v.status_at }; }) };
    },
    admin_audit: function (a) {
      return { status: 'ok', entries: S.audit.slice().reverse().slice(0, Number(a.p_limit) || 50) };
    }
  };

  function handle(fn, args) {
    S = load() || S;
    if (!S) buildFresh();
    sweep();
    var out;
    if (VOL[fn]) {
      var vol = volBy(args.p_token);
      if (!vol || (!vol.active && fn !== 'vol_submit')) out = { status: 'unauthorized' };
      else { vol.last_seen_at = iso(now()); out = VOL[fn](args, vol); }
    } else if (ADMIN[fn]) {
      var ad = null;
      S.admins.forEach(function (x) { if (x.token === args.p_admin) ad = x; });
      out = ad ? ADMIN[fn](args, ad) : { status: 'unauthorized' };
    } else {
      out = { status: 'error', message: 'Unknown function ' + fn };
    }
    save();
    return out;
  }

  /* ---------- shared-origin guard ----------
   * On GitHub Pages this demo shares an origin (avery-aidems.github.io) with the real E-day app, which uses the
   * same storage keys. Ignore anything the real app left in this browser: a real volunteer token, or queued results. */
  function knownTokens() {
    var t = { 'demo-caller': 1, 'demo-vbm': 1 };
    try {
      var st = JSON.parse(window.localStorage.getItem(KEY) || 'null');
      if (st && st.volunteers) st.volunteers.forEach(function (v) { t[v.token] = 1; });
    } catch (e) { /* ignore */ }
    return t;
  }
  (function guardSharedOrigin() {
    try {
      var known = knownTokens();
      var q = JSON.parse(window.localStorage.getItem('pb_queue_v1') || '[]');
      if (Array.isArray(q)) {
        var keep = q.filter(function (x) { return x && known[x.token]; });
        if (keep.length !== q.length) window.localStorage.setItem('pb_queue_v1', JSON.stringify(keep));
      }
      ['localStorage', 'sessionStorage'].forEach(function (s) {
        var tok = window[s].getItem('pb_token');
        if (tok && !known[tok]) { window[s].removeItem('pb_token'); window.localStorage.removeItem('pb_holding'); }
      });
      var at = window.sessionStorage.getItem('admin_token');
      if (at && at !== 'demo-admin') window.sessionStorage.removeItem('admin_token');
    } catch (e) { /* ignore */ }
  })();

  /* ---------- open straight into the demo when no link token is given ---------- */
  (function defaultLinks() {
    try {
      var page = /admin\.html$/i.test(location.pathname) ? 'admin' : 'vol';
      var h = String(location.hash || '');
      if (page === 'vol' && !/(?:^#|&)t=/.test(h)) {
        var had = null;
        try { had = window.sessionStorage.getItem('pb_token') || window.localStorage.getItem('pb_token'); } catch (e) { /* ignore */ }
        if (!had) location.hash = 't=demo-caller';
      }
      if (page === 'admin' && !/(?:^|[#&])a=/.test(h)) {
        var hadA = null;
        try { hadA = window.sessionStorage.getItem('admin_token'); } catch (e) { /* ignore */ }
        if (!hadA) location.hash = 'a=demo-admin';
      }
    } catch (e) { /* ignore */ }
  })();

  /* ---------- fetch shim ---------- */
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (url, opts) {
    var m = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(url));
    if (!m) return realFetch ? realFetch(url, opts) : Promise.reject(new TypeError('offline demo'));
    var args = {};
    try { args = JSON.parse((opts && opts.body) || '{}'); } catch (e) { args = {}; }
    var body = JSON.stringify(handle(m[1], args));
    var delay = 150 + Math.floor(Math.random() * 150);   // feels like a real round trip
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })); }, delay);
    });
  };

  // Admin page polls every 5 s; when the volunteer page writes, other tabs pick it up on their next call.
  window.addEventListener('storage', function (e) { if (e.key === KEY) S = null; });

  /* ---------- small "Demo" pill with Reset (hidden with ?clean) ---------- */
  function pill() {
    if (/(^|[?&])clean\b/.test(location.search)) return;
    var box = document.createElement('div');
    var s = box.style;
    s.position = 'fixed'; s.left = '10px'; s.bottom = '10px'; s.zIndex = '9999';
    s.background = '#7c3aed'; s.color = '#fff'; s.font = '600 12px system-ui, sans-serif';
    s.padding = '6px 10px'; s.borderRadius = '999px'; s.boxShadow = '0 2px 8px rgba(0,0,0,.25)'; s.opacity = '0.92';
    box.appendChild(document.createTextNode('Demo · synthetic data '));
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = 'Reset';
    var bs = b.style;
    bs.marginLeft = '6px'; bs.font = 'inherit'; bs.border = '0'; bs.borderRadius = '999px';
    bs.padding = '2px 8px'; bs.cursor = 'pointer'; bs.background = '#fff'; bs.color = '#7c3aed';
    b.addEventListener('click', function () {
      if (!window.confirm('Reset the demo to its starting state?')) return;
      try {
        window.localStorage.removeItem(KEY);
        ['pb_queue_v1', 'pb_holding'].forEach(function (k) { window.localStorage.removeItem(k); });
      } catch (e) { /* ignore */ }
      S = null; buildFresh(); location.reload();
    });
    box.appendChild(b);
    document.body.appendChild(box);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pill); else pill();

  window.PB_DEMO = { reset: function () { try { window.localStorage.removeItem(KEY); } catch (e) { /* ignore */ } S = null; buildFresh(); } };
})();
