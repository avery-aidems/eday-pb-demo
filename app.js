/* E-day phone bank: volunteer page. Vanilla JS. All data is rendered with textContent / createElement. */
(function () {
  'use strict';
  if (window.top !== window.self) { document.documentElement.style.display = 'none'; return; }  // no framing

  var CFG = window.APP_CONFIG || {};
  var K_TOKEN = 'pb_token', K_QUEUE = 'pb_queue_v1', K_HOLD = 'pb_holding';

  var HH_BUTTONS = [
    ['no_answer', 'No answer'], ['busy', 'Busy'], ['left_voicemail', 'Left voicemail'],
    ['wrong_number', 'Wrong number'], ['disconnected', 'Disconnected'], ['do_not_call', 'Do not call'],
    ['moved_household', 'Moved (no one here)']
  ];
  var FINAL_HH = { wrong_number: 1, disconnected: 1, do_not_call: 1, moved_household: 1 };
  var VOTER_OUTCOMES = [
    ['talked_will_vote', 'Talked: will vote'], ['talked_already_voted', 'Talked: already voted'],
    ['talked_refused', 'Talked: refused'], ['talked_not_voting', 'Talked: not voting'], ['call_back', 'Not available, call back'],
    ['moved', 'Moved'], ['deceased', 'Deceased'],
    ['language_spanish', 'Language: Spanish'], ['language_other', 'Language: Other']
  ];
  var SKIP_REASONS = [['wrong_person', 'Wrong person'], ['not_now', 'Not now'], ['other', 'Other']];
  var DEFAULT_RACE = { SD10: 'SD 10', HD37: 'HD 37', HD39: 'HD 39' };

  /* ---------- storage (every access wrapped) ---------- */
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function ssGet(k) { try { return window.sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { window.sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  /* ---------- state ---------- */
  var state = {
    token: null, view: 'loading', busy: false, notice: '', msg: '', retry: null,
    claim: null, voters: [], resultId: null, dialed: false, dialLink: false,
    reserveFail: '', skipOpen: false, confirming: null, choices: {}, support: {}, note: '',
    submitError: '', lostNote: false, nextAt: null
  };
  var me = null;           // vol_me result
  var queue = [];          // pending results (no names / phones)
  var outcomes = {};       // result_id -> {status, message}
  var unauthorized = false;
  var flushing = null, retryTimer = null, backoff = 2000;
  var hbTimer = null, hbBusy = false, claiming = false;
  var saveBtnEl = null, helperEl = null;
  var toastTimer = null;

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === false || v === null || v === undefined) return;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
        else if (v === true) e.setAttribute(k, '');
        else e.setAttribute(k, v);
      });
    }
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }
  function uuid() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* fall through */ }
    var b = new Uint8Array(16);
    try { crypto.getRandomValues(b); } catch (e) { for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var s = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20);
  }
  function phoneDigits(p) {
    var d = String(p || '').replace(/\D/g, '');
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    return d;
  }
  function fmtPhone(p) {
    var d = phoneDigits(p);
    if (d.length === 10) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
    return String(p || '');
  }
  function telHref(p) {
    var d = phoneDigits(p);
    return d.length === 10 ? 'tel:+1' + d : null;
  }
  function phoneTypeLabel(t) {
    if (t === 'Verified Cell' || t === 'Likely Cell') return 'Cell';
    if (t === 'Likely Not a Cell' || t === 'Not a Cell') return 'Likely landline';
    return '';
  }
  function fmtTimeET(iso) {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })
        .format(new Date(iso));
    } catch (e) { return ''; }
  }
  function fullName(v) { return ((v.first_name || '') + ' ' + (v.last_name || '')).replace(/\s+/g, ' ').trim() || 'Unknown'; }
  function firstWord(s) { return String(s || '').trim().split(/\s+/)[0] || ''; }
  function poolLabel(p) { return p === 'vbm' ? 'Mail-ballot list' : 'Main list'; }
  function content() { return (me && me.content) || {}; }
  function raceLabel(key) {
    var rl = content().race_labels || {};
    return rl[key] || DEFAULT_RACE[key] || key;
  }
  function hdNum(hd) { var n = parseInt(hd, 10); return isNaN(n) ? null : n; }
  function tierText(t) {
    var m = /^(\d)\s*\/\s*3$/.exec(String(t || ''));
    return m ? 'Voted ' + m[1] + ' of last 3' : '';
  }
  function toast(text, ms) {
    var el = $('toast');
    el.textContent = text; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || 2200);
  }

  /* ---------- RPC ---------- */
  async function rpc(fn, args, timeoutMs) {
    if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) return { net: true };
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, timeoutMs || 10000);
    try {
      var res = await fetch(String(CFG.SUPABASE_URL).replace(/\/+$/, '') + '/rest/v1/rpc/' + fn, {
        method: 'POST',
        headers: { 'apikey': CFG.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(args || {}),
        signal: ctl.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'
      });
      if (res.status !== 200) return { net: true, http: res.status };
      var data = await res.json();
      if (!data || typeof data.status !== 'string') return { net: true };
      return { net: false, data: data };
    } catch (e) {
      return { net: true };
    } finally {
      clearTimeout(t);
    }
  }

  /* ---------- offline result queue ---------- */
  function loadQueue() {
    try {
      var a = JSON.parse(lsGet(K_QUEUE) || '[]');
      if (!Array.isArray(a)) return [];
      return a.filter(function (q) { return q && q.result_id && q.claim_token && q.household_outcome; });
    } catch (e) { return []; }
  }
  function saveQueue() { lsSet(K_QUEUE, JSON.stringify(queue)); }

  function flushQueue() {
    if (flushing) return flushing;
    var p = doFlush();
    flushing = p;
    p.then(function () { if (flushing === p) flushing = null; });
    return p;
  }
  async function doFlush() {
    clearTimeout(retryTimer); retryTimer = null;
    var ok = true;
    while (queue.length) {
      var item = queue[0];
      var r = await rpc('vol_submit', {
        p_token: item.token || state.token, p_claim_token: item.claim_token, p_result_id: item.result_id,
        p_household_outcome: item.household_outcome, p_voter_outcomes: item.voter_outcomes || [],
        p_note: item.note || null
      }, 15000);
      if (r.net) { ok = false; break; }
      var d = r.data;
      if (d.status === 'ok') {
        outcomes[item.result_id] = { status: 'ok' };
        if (d.applied !== 'replay' && me) me.calls_today = (me.calls_today || 0) + 1;
        queue.shift(); saveQueue();
      } else if (d.status === 'unauthorized') {
        unauthorized = true; ok = false; break;
      } else {
        outcomes[item.result_id] = { status: 'error', message: d.message || 'Could not save this result.' };
        queue.shift(); saveQueue();
        toast('A result was not saved: ' + (d.message || 'server refused it') + ' Tell your lead.', 8000);
      }
    }
    if (unauthorized) {
      showUnauth();
    } else if (!ok) {
      retryTimer = setTimeout(flushQueue, backoff);
      backoff = Math.min(30000, backoff * 2);
    } else {
      backoff = 2000;
    }
    renderBadge();
    if (ok && !queue.length && state.view === 'waiting') {
      toast('Saved');
      loadNext();
    } else if (state.view === 'home' || state.view === 'waiting') {
      render();
    }
    return ok && !queue.length;
  }

  /* ---------- views ---------- */
  function showUnauth() {
    finishClaim();
    state.view = 'unauth'; render();
  }
  function finishClaim() {
    state.claim = null; state.voters = []; state.dialed = false; state.dialLink = false;
    state.reserveFail = ''; state.skipOpen = false; state.confirming = null;
    state.choices = {}; state.support = {}; state.note = ''; state.submitError = ''; state.lostNote = false;
    saveBtnEl = null; helperEl = null;
    if (state.view === 'household') state.view = 'home';
    lsDel(K_HOLD);
  }

  function renderHeader() {
    var hd = $('hdr');
    if (!me || state.view === 'unauth' || state.view === 'nocred') { hd.hidden = true; return; }
    hd.hidden = false; clear(hd);
    hd.appendChild(h('div', { class: 'hdr-top' }, [
      h('span', { class: 'hdr-name', text: me.name || 'Volunteer' }),
      h('span', { class: 'hdr-meta', text: poolLabel(state.claim ? state.claim.pool : me.pool) + ' · Calls today: ' + (me.calls_today || 0) })
    ]));
    var pfb = String(content().paid_for_by || '').trim();
    if (pfb) {   // optional: the banner shows only when a "Paid for by" line is configured
      var say = /^paid for by/i.test(pfb) ? 'Say: ' + pfb : 'Say: Paid for by ' + pfb;
      hd.appendChild(h('div', { class: 'say', text: say }));
    }
  }

  function renderBadge() {
    var b = $('badge'); clear(b);
    if (!queue.length) { b.hidden = true; return; }
    b.hidden = false;
    b.appendChild(h('span', { text: queue.length === 1 ? '1 result not saved yet' : queue.length + ' results not saved yet' }));
    b.appendChild(h('button', {
      class: 'btn btn-alt btn-inline', type: 'button', text: 'Retry now',
      onclick: function () { backoff = 2000; flushQueue(); }
    }));
  }

  function msgView(main, title, body, buttons) {
    var box = h('section', { class: 'card msg' }, [h('h2', { text: title })]);
    if (body) box.appendChild(h('p', { text: body }));
    var st = h('div', { class: 'stack' });
    (buttons || []).forEach(function (b) { st.appendChild(b); });
    box.appendChild(st);
    main.appendChild(box);
  }
  function getNextBtn(label) {
    return h('button', {
      class: 'btn btn-big', type: 'button', text: label || 'Get next',
      disabled: state.busy || queue.length > 0, onclick: loadNext
    });
  }

  function render() {
    renderHeader(); renderBadge();
    var main = $('main'); clear(main);
    saveBtnEl = null; helperEl = null;
    switch (state.view) {
      case 'loading':
        main.appendChild(h('p', { class: 'muted center', text: 'Loading…' })); break;
      case 'nocred':
        msgView(main, 'Use the personal link you were given.', 'Open the link your lead sent you.'); break;
      case 'noconfig':
        msgView(main, 'App is not configured.', 'Tell your lead.'); break;
      case 'unauth':
        msgView(main, 'This link is no longer active', 'Ask your lead for a new link.'); break;
      case 'offline':
        msgView(main, 'No connection', state.msg || 'Could not reach the server. Check your signal.', [
          h('button', { class: 'btn btn-big', type: 'button', text: 'Try again', onclick: function () { (state.retry || boot)(); } })
        ]); break;
      case 'wait':
        msgView(main, 'Please wait', state.msg || 'Try again in a moment.', [
          h('button', { class: 'btn btn-big', type: 'button', text: 'Check again', onclick: function () { (state.retry || boot)(); } })
        ]); break;
      case 'closed':
        msgView(main, 'Calling is paused', 'Wait for your lead to say calling is open.', [getNextBtn('Check again')]); break;
      case 'empty':
        msgView(main, 'No one left to call right now',
          state.nextAt ? 'Next retry at ' + (fmtTimeET(state.nextAt) || 'soon') + ' ET.' : 'Try again in a few minutes.',
          [getNextBtn('Check again')]); break;
      case 'waiting':
        msgView(main, 'Result saved on this phone',
          'It will be sent as soon as you have signal. You can get the next household once it is sent.',
          [getNextBtn('Get next')]); break;
      case 'home':
        if (state.notice) main.appendChild(h('div', { class: 'notice', role: 'alert', text: state.notice }));
        main.appendChild(h('div', { class: 'card msg' }, [
          h('div', { class: 'howto' }, [
            h('p', { text: '1) Tap Call.' }),
            h('p', { text: '2) Read the script.' }),
            h('p', { text: '3) Come back here and tap what happened.' })
          ]),
          getNextBtn('Get next')
        ])); break;
      case 'household':
        renderHousehold(main); break;
    }
  }

  /* ---------- household screen ---------- */
  function renderHousehold(main) {
    var c = state.claim;
    var card = h('section', { class: 'card phone-card' });
    card.appendChild(h('div', { class: 'phone-num', text: fmtPhone(c.phone) }));
    var typ = phoneTypeLabel(c.phone_type);
    if (c.attempts > 0) typ += (typ ? ' · ' : '') + 'Retry (attempt ' + (c.attempts + 1) + ')';
    card.appendChild(h('div', { class: 'phone-type', text: typ || ' ' }));

    if (state.voters.some(function (v) { return v.vbm === 'Y'; })) {
      card.appendChild(h('div', { class: 'vbm', role: 'note' }, [
        h('strong', { text: 'Mail ballot not returned' }),
        document.createTextNode(String(content().vbm_instructions || ''))
      ]));
    }
    if (!state.voters.length) {
      card.appendChild(h('div', { class: 'info', role: 'status', text: 'No one on this number needs a call anymore.' }));
    }

    var href = telHref(c.phone);
    if (!state.dialed) {
      if (state.reserveFail) {
        var m = state.reserveFail === 'closed'
          ? "Couldn't reserve this call. Calling is paused. You can skip this household."
          : state.reserveFail === 'badphone'
            ? 'This phone number looks invalid. Skip this household.'
            : state.reserveFail === 'skipnet'
              ? "Couldn't skip. Check your signal and try again."
              : "Couldn't connect. Tap Try call again.";
        card.appendChild(h('div', { class: 'alert', role: 'alert', text: m }));
      }
      var stack = h('div', { class: 'stack' });
      if (!state.voters.length) {
        // Nobody left to call on this number: release it, then claim the next one.
        stack.appendChild(h('button', {
          class: 'btn btn-big', type: 'button', disabled: state.busy,
          text: state.busy ? 'Working…' : 'Get next', onclick: doReleaseEmpty
        }));
      } else if (state.reserveFail !== 'closed' && state.reserveFail !== 'badphone') {
        stack.appendChild(h('button', {
          class: 'btn btn-call', type: 'button', disabled: state.busy,
          text: state.busy ? 'Reserving…' : (state.reserveFail === 'net' ? 'Try call again' : 'Call'),
          onclick: doCall
        }));
      }
      card.appendChild(stack);

      if (state.voters.length) {
        var skipWrap = h('div', { class: 'skip-wrap' });
        if (!state.skipOpen) {
          skipWrap.appendChild(h('button', {
            class: 'btn btn-alt', type: 'button', text: 'Skip', disabled: state.busy,
            onclick: function () { state.skipOpen = true; render(); }
          }));
        } else {
          skipWrap.appendChild(h('div', { class: 'section-title', text: 'Why skip?' }));
          var rs = h('div', { class: 'skip-reasons' });
          SKIP_REASONS.forEach(function (r) {
            rs.appendChild(h('button', { class: 'btn btn-alt', type: 'button', text: r[1], disabled: state.busy, onclick: function () { doSkip(r[0]); } }));
          });
          skipWrap.appendChild(rs);
          skipWrap.appendChild(h('button', {
            class: 'btn btn-alt skip-cancel', type: 'button', text: 'Cancel', disabled: state.busy,
            onclick: function () { state.skipOpen = false; render(); }
          }));
        }
        card.appendChild(skipWrap);
      }
    } else {
      var st2 = h('div', { class: 'stack' });
      st2.appendChild(h('p', { class: 'muted', text: 'When the call ends, come back here and tap what happened.' }));
      st2.appendChild(h('button', {
        class: 'btn btn-call', type: 'button', text: 'Record result ↓',
        onclick: function () { var r = $('results'); if (r && r.scrollIntoView) r.scrollIntoView({ block: 'start' }); }
      }));
      if (href && state.dialLink) {
        st2.appendChild(h('a', { class: 'btn btn-dial', href: href }, ['Tap to dial', h('br'), fmtPhone(c.phone)]));
        st2.appendChild(h('p', { class: 'muted', text: "If your phone didn't start the call, use the Tap to dial button." }));
      }
      card.appendChild(st2);
    }
    main.appendChild(card);

    if (state.lostNote) {
      main.appendChild(h('div', { class: 'info', role: 'status', text: 'This call timed out on the server, but you can still save what happened.' }));
    }

    scriptBlocks().forEach(function (s) { main.appendChild(s); });
    state.voters.forEach(function (v) { main.appendChild(voterCard(v)); });
    if (state.dialed) main.appendChild(resultsPanel());
  }

  function voterCard(v) {
    var card = h('article', { class: 'card voter' });
    card.appendChild(h('h3', { class: 'vname', text: fullName(v) }));
    var badges = h('div', { class: 'badges' });
    var sdn = hdNum(v.sd);
    if (sdn === 10) badges.appendChild(h('span', { class: 'badge', text: raceLabel('SD10') }));
    else if (sdn !== null) badges.appendChild(h('span', { class: 'badge', text: 'SD ' + sdn }));
    var n = hdNum(v.hd);
    if (n === 37 || n === 39) badges.appendChild(h('span', { class: 'badge', text: raceLabel('HD' + n) }));
    else if (n !== null) badges.appendChild(h('span', { class: 'badge', text: 'HD ' + n }));
    if (v.voted_primary26 === 'Y') badges.appendChild(h('span', { class: 'badge primary', text: 'Voted Aug primary' }));
    if (v.vbm === 'Y') badges.appendChild(h('span', { class: 'badge warn', text: 'Mail ballot not returned' }));
    card.appendChild(badges);
    var tt = tierText(v.tier);
    if (tt) card.appendChild(h('div', { class: 'tier', text: tt }));
    card.appendChild(h('div', { class: 'poll' }, [
      h('div', { class: 'lbl', text: 'Polling place' }),
      h('div', { class: 'pname', text: v.polling_name || 'Not available' }),
      h('div', { text: v.polling_address || '' }),
      (v.precinct || v.county) ? h('div', { class: 'precinct-county', text: [
        v.precinct ? 'Precinct ' + v.precinct : '',
        v.county ? (/county$/i.test(String(v.county)) ? String(v.county) : v.county + ' County') : ''
      ].filter(Boolean).join(' \u00b7 ') }) : null
    ]));
    return card;
  }

  function fillScript(tpl, vals) {
    return String(tpl).replace(/\{(voter_first|volunteer_first|polling_place|polling_address|paid_for_by)\}/g,
      function (m, k) { return vals[k] === undefined ? m : vals[k]; });
  }
  function scriptBlocks() {
    // One block per (script kind, HD, polling place): the script follows each voter's OWN mail-ballot status
    // (main-list housemates on a shared phone get the main script) and each voter's own polling place.
    var scripts = content().scripts || {};
    var groups = [], idx = {};
    state.voters.forEach(function (v) {
      var kind = v.vbm === 'Y' ? 'vbm' : 'main';
      var hd = hdNum(v.hd), sd = hdNum(v.sd);
      var key = kind + '|' + hd + '|' + sd + '|' + (v.polling_name || '') + '|' + (v.polling_address || '');
      if (!(key in idx)) { idx[key] = groups.length; groups.push({ kind: kind, hd: hd, sd: sd, voters: [] }); }
      groups[idx[key]].voters.push(v);
    });
    var out = [];
    groups.forEach(function (g) {
      // Most specific first: <kind>_HD<n>_SD<m>. The plain <kind>_HD<n> scripts name the SD 10 candidate,
      // so they are used only for SD 10 voters; anyone else falls back to the pool default.
      var tpl = (g.hd !== null && g.sd !== null) ? scripts[g.kind + '_HD' + g.hd + '_SD' + g.sd] : '';
      if ((typeof tpl !== 'string' || !tpl.trim()) && g.hd !== null && g.sd === 10) tpl = scripts[g.kind + '_HD' + g.hd];
      if (typeof tpl !== 'string' || !tpl.trim()) tpl = scripts[g.kind + '_default'];
      if (typeof tpl !== 'string' || !tpl.trim()) return;
      var first = g.voters[0];
      var seen = {}, names = [];
      g.voters.forEach(function (v) {
        var f = (v.first_name || '').trim();
        if (f && !seen[f.toLowerCase()]) { seen[f.toLowerCase()] = 1; names.push(f); }
      });
      var text = fillScript(tpl, {
        voter_first: names.join(' / '),
        volunteer_first: firstWord(me && me.name),
        polling_place: first.polling_name || '',
        polling_address: first.polling_address || '',
        paid_for_by: String(content().paid_for_by || '')
      });
      var title = 'Script';
      if (groups.length > 1) title += ' for ' + g.voters.map(fullName).join(', ');
      out.push(h('section', { class: 'card script' }, [
        h('h3', { text: title }),
        h('div', { class: 'script-text prewrap', text: text })
      ]));
    });
    return out;
  }

  /* ---------- results panel ---------- */
  function resultsPanel() {
    var p = h('section', { class: 'card results', id: 'results' });
    p.appendChild(h('h3', { text: 'How did the call go?' }));
    if (state.submitError) p.appendChild(h('div', { class: 'alert', role: 'alert', id: 'submit-alert', text: state.submitError }));

    p.appendChild(h('div', { class: 'section-title', text: 'No conversation / bad number' }));
    var grid = h('div', { class: 'hh-grid' });
    HH_BUTTONS.forEach(function (b) {
      grid.appendChild(h('button', {
        class: 'btn' + (FINAL_HH[b[0]] ? ' final' : ''), type: 'button', text: b[1], disabled: state.busy,
        onclick: function () {
          if (FINAL_HH[b[0]]) { state.confirming = b[0]; render(); }
          else submit(b[0], [], null);
        }
      }));
    });
    p.appendChild(grid);

    if (state.confirming) {
      var lbl = '';
      HH_BUTTONS.forEach(function (b) { if (b[0] === state.confirming) lbl = b[1]; });
      p.appendChild(h('div', { class: 'confirm alert', role: 'alert' }, [
        h('p', { text: 'Mark "' + lbl + '" for everyone on this phone? This is final.' }),
        h('div', { class: 'stack' }, [
          h('button', { class: 'btn btn-danger', type: 'button', text: 'Yes, ' + lbl, disabled: state.busy, onclick: function () { var c = state.confirming; state.confirming = null; submit(c, [], null); } }),
          h('button', { class: 'btn btn-alt', type: 'button', text: 'Cancel', disabled: state.busy, onclick: function () { state.confirming = null; render(); } })
        ])
      ]));
    }

    if (!state.voters.length) return p;
    p.appendChild(h('hr', { class: 'divider' }));
    p.appendChild(h('div', { class: 'section-title', text: 'Someone answered' }));
    state.voters.forEach(function (v) {
      var who = h('div', { class: 'who' });
      who.appendChild(h('div', { class: 'who-name', text: fullName(v) }));
      // Optional support rating, above the result choices; active only once a "Talked: ..." result is chosen.
      var sopts = Array.isArray(content().support_options) ? content().support_options : [];
      var slabel = String(content().support_label || 'Support');
      var sp = null;
      function isTalked() { return /^talked_/.test(state.choices[v.vanid] || ''); }
      function syncSupport() {
        if (!sp) return;
        if (!isTalked()) delete state.support[v.vanid];
        Array.prototype.forEach.call(sp.children, function (x) {
          x.disabled = state.busy || !isTalked();
          x.setAttribute('aria-pressed', state.support[v.vanid] === x.getAttribute('data-code') ? 'true' : 'false');
        });
        if (sHint) sHint.textContent = isTalked() ? slabel + ' (optional, tap again to clear)' : slabel + ': choose a "Talked" result first';
      }
      var sHint = null;
      if (sopts.length) {
        sHint = h('div', { class: 'support-lbl' });
        sp = h('div', { class: 'seg-grid support-grid', role: 'group', 'aria-label': slabel + ' for ' + fullName(v) });
        sopts.forEach(function (o) {
          if (!o || typeof o.code !== 'string') return;
          var b = h('button', { class: 'seg seg-support', type: 'button', text: String(o.label || o.code), 'data-code': o.code });
          b.addEventListener('click', function () {
            if (state.busy || !isTalked()) return;
            state.support[v.vanid] = state.support[v.vanid] === o.code ? undefined : o.code;
            if (!state.support[v.vanid]) delete state.support[v.vanid];
            syncSupport();
          });
          sp.appendChild(b);
        });
        who.appendChild(sHint);
        who.appendChild(sp);
      }
      var sg = h('div', { class: 'seg-grid', role: 'group', 'aria-label': 'Result for ' + fullName(v) });
      VOTER_OUTCOMES.forEach(function (o) {
        var btn = h('button', {
          class: 'seg', type: 'button', text: o[1], disabled: state.busy,
          'aria-pressed': state.choices[v.vanid] === o[0] ? 'true' : 'false'
        });
        btn.addEventListener('click', function () {
          if (state.busy) return;
          state.choices[v.vanid] = o[0];
          Array.prototype.forEach.call(sg.children, function (x) { x.setAttribute('aria-pressed', x === btn ? 'true' : 'false'); });
          syncSupport();
          updateSave();
        });
        sg.appendChild(btn);
      });
      who.appendChild(sg);
      syncSupport();
      p.appendChild(who);
    });
    p.appendChild(h('label', { class: 'lbl-note', for: 'note', text: 'Note (optional)' }));
    var ta = h('textarea', { id: 'note', maxlength: '500', rows: '3' });
    ta.value = state.note;
    ta.addEventListener('input', function () { state.note = ta.value; });
    p.appendChild(ta);
    helperEl = h('p', { class: 'helper', 'aria-live': 'polite' });
    p.appendChild(helperEl);
    saveBtnEl = h('button', {
      class: 'btn btn-call', type: 'button', text: state.busy ? 'Saving…' : 'Save & next',
      onclick: submitAnswered
    });
    p.appendChild(h('div', { class: 'stack' }, [saveBtnEl]));
    updateSave();
    return p;
  }
  function allChosen() {
    return state.voters.length > 0 && state.voters.every(function (v) { return !!state.choices[v.vanid]; });
  }
  function updateSave() {
    if (saveBtnEl) saveBtnEl.disabled = state.busy || !allChosen();
    if (helperEl) {
      var left = state.voters.filter(function (v) { return !state.choices[v.vanid]; }).length;
      helperEl.textContent = left
        ? "Pick one answer for each person (" + left + " left). If someone wasn't on the phone, choose 'Not available, call back'."
        : 'All set. Tap Save & next.';
    }
  }
  function showSubmitError(text, toastMs) {
    state.submitError = text; render();
    if (toastMs) toast(text, toastMs);
    var a = $('submit-alert');
    if (a && a.scrollIntoView) a.scrollIntoView({ block: 'center' });
  }

  /* ---------- actions ---------- */
  function setClaim(d) {
    state.claim = d.claim; state.voters = d.voters || [];
    state.resultId = uuid(); state.dialed = !!d.claim.dialed; state.dialLink = state.dialed;
    state.reserveFail = ''; state.skipOpen = false; state.confirming = null;
    state.choices = {}; state.support = {}; state.note = ''; state.submitError = ''; state.lostNote = false;
    state.notice = '';
    lsSet(K_HOLD, '1');
    state.view = 'household';
    startHeartbeat();
    render();
    try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
  }

  async function loadNext() {
    if (claiming || state.busy) return;
    if (queue.length) { renderBadge(); render(); return; }
    claiming = true; state.busy = true; state.notice = '';
    render();
    var r = await rpc('vol_claim_next', { p_token: state.token }, 10000);
    claiming = false; state.busy = false;
    if (r.net) {
      state.view = 'offline'; state.msg = 'Could not reach the server. Check your signal.';
      state.retry = loadNext; render(); return;
    }
    var d = r.data;
    if (d.status === 'ok' && d.claim) { setClaim(d); return; }
    if (d.status === 'closed') { finishClaim(); state.view = 'closed'; render(); return; }
    if (d.status === 'empty') { finishClaim(); state.nextAt = d.next_eligible_at || null; state.view = 'empty'; render(); return; }
    if (d.status === 'unauthorized') { showUnauth(); return; }
    state.view = 'wait'; state.msg = d.message || 'Try again in a moment.';
    state.retry = loadNext; render();
  }

  async function doCall() {
    var claim = state.claim;
    if (state.busy || !claim) return;
    if (!telHref(claim.phone)) { state.reserveFail = 'badphone'; render(); return; }
    state.busy = true; state.reserveFail = ''; render();
    var r = await rpc('vol_mark_dialed', { p_token: state.token, p_claim_token: claim.claim_token }, 4000);
    state.busy = false;
    if (state.claim !== claim) { render(); return; }
    var s = r.net ? null : r.data.status;
    if (s === 'ok') {
      state.dialed = true; state.dialLink = true;
      try { if (!window.PB_DEMO) window.location.href = telHref(claim.phone); } catch (e) { /* fallback link is shown */ }  // DEMO: don't launch FaceTime
      render();
      return;
    }
    if (s === 'unauthorized') { showUnauth(); return; }
    if (s === 'lost') {
      finishClaim(); state.notice = "Couldn't reserve this call. Tap Get next.";
      state.view = 'home'; render(); return;
    }
    state.reserveFail = s === 'closed' ? 'closed' : 'net';
    render();
  }

  async function doSkip(reason) {
    var claim = state.claim;
    if (state.busy || !claim) return;
    state.busy = true; render();
    var r = await rpc('vol_release', { p_token: state.token, p_claim_token: claim.claim_token, p_reason: reason }, 8000);
    state.busy = false;
    if (state.claim !== claim) { render(); return; }
    var s = r.net ? null : r.data.status;
    if (s === 'ok' || s === 'lost') {
      finishClaim();
      if (s === 'lost') state.notice = 'This household was already released. Tap Get next.';
      else toast('Skipped');
      state.view = 'home'; render(); return;
    }
    if (s === 'dialed') {
      state.dialed = true; state.dialLink = true; state.skipOpen = false;
      showSubmitError('This call was already dialed, so please record the result.');
      return;
    }
    if (s === 'unauthorized') { showUnauth(); return; }
    state.skipOpen = false; state.reserveFail = 'skipnet'; render();
  }

  async function doReleaseEmpty() {
    var claim = state.claim;
    if (state.busy || !claim) return;
    state.busy = true; state.reserveFail = ''; render();
    var r = await rpc('vol_release', { p_token: state.token, p_claim_token: claim.claim_token, p_reason: 'no_open_voters' }, 8000);
    state.busy = false;
    if (state.claim !== claim) { render(); return; }
    var s = r.net ? null : r.data.status;
    if (s === 'ok' || s === 'lost') { finishClaim(); await loadNext(); return; }
    if (s === 'dialed') {
      state.dialed = true; state.dialLink = true;
      showSubmitError('This call was already dialed, so please record the result.');
      return;
    }
    if (s === 'unauthorized') { showUnauth(); return; }
    state.reserveFail = 'skipnet'; render();
  }

  function submitAnswered() {
    if (!allChosen() || state.busy) return;
    var vo = state.voters.map(function (v) {
      var o = { vanid: v.vanid, outcome: state.choices[v.vanid] };
      if (/^talked_/.test(o.outcome) && state.support[v.vanid]) o.support = state.support[v.vanid];
      return o;
    });
    var note = String(state.note || '').trim();
    submit('answered', vo, note || null);
  }

  async function submit(ho, vo, note) {
    var claim = state.claim;
    if (state.busy || !claim) return;
    state.busy = true; state.submitError = ''; render();
    var item = { result_id: state.resultId, claim_token: claim.claim_token, household_outcome: ho, voter_outcomes: vo, note: note, token: state.token };
    var dup = queue.some(function (q) { return q.result_id === item.result_id; });
    if (!dup) { queue.push(item); saveQueue(); }
    delete outcomes[item.result_id];
    renderBadge();
    await flushQueue();
    state.busy = false;
    if (unauthorized) return;
    var o = outcomes[item.result_id];
    if (o && o.status === 'ok') {
      toast('Saved');
      finishClaim();
      await loadNext();
      return;
    }
    if (o && o.status === 'error') {
      var em = String(o.message || '').replace(/[.\s]+$/, '') || 'the server refused it';
      showSubmitError('Not saved: ' + em + '. Tell your lead this number: ' + fmtPhone(claim.phone) + '.', 8000);
      return;
    }
    // Network failure: result stays queued and retries in the background.
    finishClaim();
    state.view = 'waiting'; render();
  }

  /* ---------- heartbeat ---------- */
  function startHeartbeat() {
    if (hbTimer) return;
    hbTimer = setInterval(function () {
      if (document.visibilityState === 'visible') heartbeat();
    }, 30000);
  }
  async function heartbeat() {
    var c = state.claim;
    if (!c || hbBusy) return;
    hbBusy = true;
    var r = await rpc('vol_heartbeat', { p_token: state.token, p_claim_token: c.claim_token }, 8000);
    hbBusy = false;
    if (state.claim !== c || r.net) return;
    if (r.data.status === 'lost') {
      if (state.dialed) { if (!state.lostNote) { state.lostNote = true; render(); } }
      else {
        finishClaim(); state.notice = 'This household was released (timed out). Tap Get next.';
        state.view = 'home'; render();
      }
    } else if (r.data.status === 'unauthorized') {
      showUnauth();
    }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (queue.length) { backoff = 2000; flushQueue(); }
    if (state.claim) heartbeat();
  });
  window.addEventListener('online', function () { if (queue.length) { backoff = 2000; flushQueue(); } });

  /* ---------- boot ---------- */
  function readToken() {
    var tok = null;
    try {
      var hash = String(window.location.hash || '');
      if (hash.length > 1) {
        var m = /(?:^#|&)t=([^&]+)/.exec(hash);
        if (m) {
          var t = decodeURIComponent(m[1]).trim();
          if (/^[A-Za-z0-9_-]{8,128}$/.test(t)) tok = t;
        }
        if (hash.length > 1) {
          try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore */ }
    if (tok) {
      var old = ssGet(K_TOKEN) || lsGet(K_TOKEN);
      if (old && old !== tok) lsDel(K_HOLD);
      ssSet(K_TOKEN, tok); lsSet(K_TOKEN, tok);
      return tok;
    }
    return ssGet(K_TOKEN) || lsGet(K_TOKEN) || null;
  }

  async function loadMe() {
    var r = await rpc('vol_me', { p_token: state.token }, 10000);
    if (r.net) { state.busy = false; state.view = 'offline'; state.msg = 'Could not reach the server. Check your signal.'; state.retry = boot; render(); return false; }
    if (r.data.status === 'unauthorized') { state.busy = false; showUnauth(); return false; }
    if (r.data.status !== 'ok') { state.busy = false; state.view = 'wait'; state.msg = r.data.message || 'Try again in a moment.'; state.retry = boot; render(); return false; }
    me = r.data;
    return true;
  }

  async function boot() {
    if (state.busy) return;
    state.busy = true; state.view = me ? state.view : 'loading'; render();
    if (queue.length) await flushQueue();
    var ok = me ? true : await loadMe();
    state.busy = false;
    if (!ok || unauthorized) return;
    if (queue.length) { state.view = 'waiting'; render(); return; }
    if (lsGet(K_HOLD)) { await loadNext(); return; }
    state.view = 'home'; render();
  }

  function init() {
    queue = loadQueue();
    state.token = readToken();
    if (!state.token) { state.view = 'nocred'; render(); return; }
    if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) { state.view = 'noconfig'; render(); return; }
    render();
    boot();
  }
  init();
})();
