'use strict'
// The window of Hinty Agents. Plain script, no framework, no network: every action is a call through preload.cjs to
// the bridge (main.cjs -> the bridge worker). Text from the bridge or the network is always escaped.
;(function () {
  const I = window.HINTY_I18N
  const H = window.hinty
  const S = {
    lang: 'en',
    info: null,
    st: null,
    agents: null,
    agentsBusy: false,
    busy: {},
    msg: {},
    lines: [],
    pair: { digits: '', mismatch: null, starting: false, startErr: null, copied: false, expiresIn: 600 },
    voice: null,
    voiceProg: null,
    voiceMsg: null,
    armed: {},
    purge: false,
    askShell: false,
    removed: null,
    banner: null,
  }

  const t = (k, v) => I.t(S.lang, k, v)
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const fmtMB = (n) => (n >= 1e9 ? `${(n / 1073741824).toFixed(1)} GB` : `${Math.round(n / 1048576)} MB`)
  const hhmm = (ms) => { try { return new Date(ms).toLocaleTimeString(S.lang === 'no' ? 'nb' : S.lang, { hour: '2-digit', minute: '2-digit' }) } catch { return '' } }
  const sw = (on, act, extra = '') => `<button class="switch ${extra}" role="switch" aria-checked="${on ? 'true' : 'false'}" data-act="${act}"`

  // ------------------------------------------------------------------------------------------------
  // Sections
  // ------------------------------------------------------------------------------------------------

  function pairEndText(e) {
    if (!e || e.ok) return ''
    const key = { off: 'pair_off', not_allowed: 'pair_not_allowed', unreachable: 'pair_unreachable', timeout: 'pair_timeout', cancelled: 'pair_cancelled', ended: 'pair_ended', no_person: 'pair_ended', mismatch: 'pair_mismatch', no_check: 'pair_no_check' }[e.code]
    let s = key ? t(key) : t('pair_other', { message: e.message || '' })
    if (e.failedAt === 'check' && e.told === false) s += ' ' + t('pair_not_told')
    return s
  }

  function accountHtml() {
    const st = S.st
    let h = `<h2>${esc(t('sec_account'))}</h2>`
    if (!st) return h + `<p class="note">${esc(t('starting'))}</p>`
    if (st.copyError) h += `<p class="bad small">${esc(t('copy_error'))} ${esc(st.copyError)}</p>`
    if (st.paired) {
      const sv = st.service
      const linkOk = !!(sv && sv.connected)
      h += `<div class="row"><span class="dot ${linkOk ? 'on' : sv ? 'wait' : ''}"></span><span class="strong" data-testid="connected">${esc(st.account ? t('connected_as', { account: st.account }) : t('connected_plain'))}</span></div>`
      h += `<p class="note mt6">${esc(t('this_computer', { label: st.label || st.host || '' }))}. ${esc(sv ? (linkOk ? t('link_ok') : t('link_wait')) : t('service_off'))}</p>`
      if (st.pairingEnded && st.pairingEnded.ok && !(sv && sv.away && sv.away.on)) h += `<p class="ok small" data-testid="pair-ok">${esc(t('pair_ok'))}</p>`
      h += '<div class="buttons">'
      if (!sv) h += `<button class="primary" data-act="startService">${esc(t('btn_start'))}</button>`
      h += `<button class="${S.armed.unpair ? 'danger armed' : ''}" data-act="unpair">${esc(S.armed.unpair ? t('confirm_again') : t('btn_unpair'))}</button>`
      return h + '</div>'
    }
    const p = st.pairing
    if (!p) {
      const endTxt = pairEndText(st.pairingEnded)
      if (endTxt) h += `<p class="bad small" data-testid="pair-error">${esc(endTxt)}</p>`
      if (S.pair.startErr) h += `<p class="bad small">${esc(t('pair_setup'))} ${esc(S.pair.startErr)}</p>`
      h += `<p class="note">${esc(t('not_connected'))} ${esc(t('pair_intro'))}</p>`
      h += `<div class="buttons"><button class="primary" data-act="getCode" data-testid="get-code" ${S.pair.starting ? 'disabled' : ''}>${esc(t('btn_get_code'))}</button></div>`
      return h
    }
    if (p.stage === 'code') {
      if (!p.code) return h + `<p class="note">${esc(t('starting'))}</p><div class="buttons"><button data-act="cancelPair">${esc(t('btn_cancel'))}</button></div>`
      const min = Math.max(1, Math.round(((p.expiresAt || 0) - Date.now()) / 60000))
      h += `<p class="note">${esc(t('pair_code'))}</p><div class="code" data-testid="pair-code">${esc(p.pretty)}</div>`
      h += `<p class="note">${esc(t('pair_where', { min }))}</p>`
      h += '<div class="buttons">'
      if (st.panelUrl) h += `<button class="primary" data-act="openPanel">${esc(t('btn_open_panel'))}</button>`
      h += `<button data-act="copyCode">${esc(S.pair.copied ? t('copied') : t('btn_copy'))}</button><button data-act="cancelPair">${esc(t('btn_cancel'))}</button></div>`
      h += `<p class="note small mt10"><span class="dot wait"></span> ${esc(t('pair_waiting'))}</p>`
      return h
    }
    // the code was typed in a panel: the person copies the panel's 4 digits here (review 2, Z10)
    h += `<p class="strong" data-testid="pair-claimed">${esc(p.account ? t('pair_claimed', { account: p.account }) : t('pair_claimed_plain'))}</p>`
    h += `<p class="note">${esc(t('pair_ask'))}</p>`
    h += `<div class="row mt10"><input class="digits" id="digits" data-input="digits" data-testid="pair-digits" inputmode="numeric" autocomplete="one-time-code" maxlength="4" value="${esc(S.pair.digits)}" aria-label="${esc(t('pair_ask'))}">`
    h += `<button class="primary" data-act="confirmDigits" data-testid="pair-confirm" ${S.pair.digits.length === 4 ? '' : 'disabled'}>${esc(t('btn_confirm'))}</button><button data-act="cancelPair">${esc(t('btn_cancel'))}</button></div>`
    if (S.pair.mismatch) h += `<p class="warn small mt8" data-testid="pair-mismatch">${esc(S.pair.mismatch === 1 ? t('tries_1') : t('tries_n', { n: S.pair.mismatch }))}</p>`
    h += `<p class="note small mt8">${esc(t('pair_why'))}</p>`
    return h
  }

  function awayHtml() {
    const st = S.st
    let h = `<h2>${esc(t('sec_away'))}</h2>`
    const paired = !!(st && st.paired)
    const a = st && st.service ? st.service.away : null
    const on = !!(a && a.on)
    h += `<div class="away-head"><div class="away-state ${on ? 'on' : ''}" data-testid="away-state" data-on="${on ? '1' : '0'}">${esc(on ? t('state_on') : t('state_off'))}</div>${sw(on, 'toggleAway', 'big')} data-testid="away-toggle" aria-label="${esc(t('sec_away'))}" ${paired && !S.busy.away ? '' : 'disabled'}></button></div>`
    if (!paired) return h + `<p class="note mt8">${esc(t('away_needs_pair'))}</p>`
    else if (on) {
      h += `<p class="note mt8">${esc(t('away_on', { time: hhmm(a.until) }))}</p>`
      if (a.by === 'remote' && a.since) h += `<p class="warn small" data-testid="away-remote">${esc(t('away_remote', { time: hhmm(a.since) }))}</p>`
      if (st.service && !st.service.connected) h += `<p class="warn small">${esc(t('away_link_down'))}</p>`
    } else h += `<p class="note mt8">${esc(t('away_off'))}</p>`
    if (a && a.remoteRefusedAt) h += `<p class="warn small">${esc(t('remote_refused', { time: hhmm(a.remoteRefusedAt) }))}</p>`
    // the consent is its own field, off by default, with the risk spelled out next to it (security review point 2)
    h += `<div class="consent"><label class="check"><input type="checkbox" data-act="toggleRemote" data-testid="remote-consent" ${st && st.remoteAwayOn ? 'checked' : ''} ${paired && !S.busy.remote ? '' : 'disabled'}><span><span class="title">${esc(t('remote_title'))}</span><br><span class="note small">${esc(t('remote_desc'))}</span></span></label>`
    h += `<div class="risk">${esc(t('remote_risk'))}</div></div>`
    return h
  }

  function agentState(a) {
    if (a.installed) {
      if (a.id === 'claude' && a.update) return ['warn', t('agent_update')]
      if (a.id === 'codex' && !a.complete) return ['warn', t('agent_incomplete')]
      return ['on', t('agent_connected')]
    }
    if (a.found) return ['', t('agent_found', { version: a.version || '' }).trim()]
    return ['mute', t('agent_missing')]
  }

  function agentsHtml() {
    let h = `<h2><span>${esc(t('sec_agents'))}</span><button class="link" data-act="refreshAgents" ${S.agentsBusy ? 'disabled' : ''}>${esc(t('btn_check'))}</button></h2>`
    if (!S.agents) return h + `<p class="note">${esc(t('checking'))}</p>`
    const anyBusy = Object.values(S.busy).some(Boolean)
    for (const a of S.agents) {
      const [cls, label] = agentState(a)
      const busy = S.busy[a.id]
      h += `<div class="agent" data-agent="${esc(a.id)}" data-testid="agent-${esc(a.id)}"><div class="row between"><div><div class="aname">${esc(a.name)}</div><div class="astate ${cls}" data-testid="agent-state">${esc(busy ? t('working') : label)}</div></div><div class="row">`
      if (a.installed) {
        if (a.id === 'claude' && a.update) h += `<button class="primary" data-act="connect" data-id="${esc(a.id)}" ${anyBusy ? 'disabled' : ''}>${esc(t('btn_update'))}</button>`
        h += `<button data-act="disconnect" data-id="${esc(a.id)}" data-testid="agent-disconnect" ${anyBusy ? 'disabled' : ''}>${esc(t('btn_disconnect'))}</button>`
      } else if (a.found) {
        h += `<button class="primary" data-act="connect" data-id="${esc(a.id)}" data-testid="agent-connect" ${anyBusy ? 'disabled' : ''}>${esc(t('btn_connect'))}</button>`
      }
      h += '</div></div>'
      if (a.id === 'claude' && a.installed) h += `<div class="anote">${esc(t('note_claude'))}</div>`
      if (a.id === 'codex' && (a.found || a.installed)) h += `<div class="anote">${esc(t('note_codex'))}</div>`
      if (a.id === 'grok' && a.found && !a.installed) {
        h += `<label class="check anote"><input type="checkbox" data-act="askShell" ${S.askShell ? 'checked' : ''}><span>${esc(t('grok_ask_shell'))}</span></label>`
        if (S.askShell) h += `<div class="risk">${esc(t('grok_warn'))}</div>`
      }
      if (a.id === 'grok' && a.installed && a.askShell) h += `<div class="risk">${esc(t('grok_warn'))}</div>`
      if (a.id === 'openclaw' && a.found && !a.installed) h += `<div class="anote">${esc(t('note_openclaw'))}</div>`
      if (a.id === 'hermes' && a.found && !a.installed) h += `<div class="anote">${esc(t('note_hermes'))}</div>`
      const m = S.msg[a.id]
      if (m && !busy) h += `<div class="aok ${m === 'ok' ? 'ok' : 'bad'}">${esc(m === 'ok' ? t('done_ok') : t('done_bad'))}</div>`
      h += '</div>'
    }
    if (!S.agents.some((a) => a.found || a.installed)) h += `<p class="note mt8">${esc(t('agents_none'))}</p>`
    return h
  }

  function voiceHtml() {
    const v = S.voice
    let h = `<h2>${esc(t('sec_voice'))}</h2>`
    const size = v && v.models ? v.models.filter((m) => m.id === 'parakeet-v3' || m.id === 'silero-vad').reduce((n, m) => n + m.download, 0) : 0
    h += `<p class="note">${esc(t('voice_desc', { size: size ? fmtMB(size) : '640 MB' }))}</p>`
    const busy = S.busy.voice || (S.st && S.st.voiceBusy)
    if (busy) {
      const p = S.voiceProg
      const pct = p && p.total ? Math.min(100, Math.floor((p.done / p.total) * 100)) : 0
      const txt = !p || p.phase === 'engine' ? t('voice_engine') : p.phase === 'check' ? t('voice_check') : t('voice_download', { done: fmtMB(p.done), total: fmtMB(p.total) })
      h += `<progress class="bar" data-testid="voice-bar" max="100" value="${pct}"></progress><p class="note small">${esc(txt)}</p>`
      return h
    }
    h += `<div class="row between mt10"><div class="row"><span class="dot ${v && v.ready ? 'on' : ''}"></span><span data-testid="voice-state">${esc(v && v.ready ? t('voice_ready', { model: v.model }) : t('voice_none'))}</span></div>`
    h += v && (v.ready || v.sherpa) ? `<button data-act="voiceRemove">${esc(t('btn_voice_remove'))}</button>` : `<button class="primary" data-act="voiceInstall" data-testid="voice-install">${esc(t('btn_voice_install'))}</button>`
    h += '</div>'
    if (S.voiceMsg === 'bad') h += `<p class="bad small mt8">${esc(t('voice_failed'))}</p>`
    return h
  }

  function settingsHtml() {
    const i = S.info
    let h = `<h2>${esc(t('sec_settings'))}</h2>`
    if (!i) return h
    h += `<label class="check"><input type="checkbox" data-act="autostart" data-testid="autostart" ${i.openAtLogin ? 'checked' : ''}><span>${esc(t('autostart'))}</span></label>`
    h += `<label class="line mt12"><span>${esc(t('language'))}</span><select data-act="lang" data-testid="lang"><option value="">${esc(t('lang_system'))} (${esc(i.names[i.systemLang] || i.systemLang)})</option>`
    for (const l of i.langs) h += `<option value="${esc(l)}" ${i.lang === l ? 'selected' : ''}>${esc(i.names[l])}</option>`
    return h + '</select></label>'
  }

  function removeHtml() {
    let h = `<h2>${esc(t('sec_remove'))}</h2><p class="note">${esc(t('remove_desc'))}</p>`
    if (S.removed === true) return h + `<p class="ok small" data-testid="removed">${esc(S.info && S.info.platform === 'darwin' ? t('removed_mac') : t('removed_win'))}</p>`
    h += `<label class="check mt10"><input type="checkbox" data-act="purge" ${S.purge ? 'checked' : ''}><span>${esc(t('remove_data'))}</span></label>`
    h += `<div class="buttons"><button class="danger ${S.armed.remove ? 'armed' : ''}" data-act="removeAll" data-testid="remove-all" ${Object.values(S.busy).some(Boolean) ? 'disabled' : ''}>${esc(S.busy.remove ? t('working') : S.armed.remove ? t('confirm_again') : t('btn_remove'))}</button></div>`
    if (S.removed === false) h += `<p class="bad small mt8">${esc(t('done_bad'))}</p>`
    return h
  }

  function logHtml() {
    if (!S.lines.length) return ''
    return `<details><summary>${esc(t('details'))}</summary><pre class="lines" data-testid="lines">${esc(S.lines.slice(-200).join('\n'))}</pre></details>`
  }

  // ------------------------------------------------------------------------------------------------
  // Render (a section is replaced only when its HTML changed; the 4-digit field keeps focus)
  // ------------------------------------------------------------------------------------------------

  const last = {}
  function put(id, html) {
    if (last[id] === html) return
    const el = document.getElementById(id)
    const focused = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : null
    const openDetails = el.querySelector('details[open]')
    el.innerHTML = html
    last[id] = html
    if (openDetails) { const d = el.querySelector('details'); if (d) d.open = true }
    if (focused) { const f = document.getElementById(focused); if (f) { f.focus(); if (f.setSelectionRange) f.setSelectionRange(f.value.length, f.value.length) } }
  }

  function render() {
    document.documentElement.lang = S.lang
    document.getElementById('tagline').textContent = t('tagline')
    const b = document.getElementById('banner')
    b.hidden = !S.banner
    b.textContent = S.banner || ''
    put('account', accountHtml())
    put('away', awayHtml())
    put('agents', agentsHtml())
    put('voice', voiceHtml())
    put('settings', settingsHtml())
    put('remove', removeHtml())
    put('log', logHtml())
    const st = S.st
    document.getElementById('footer').textContent = st ? t('footer', { version: st.version, node: st.node }) : ''
    const d = document.getElementById('digits')
    if (d && document.activeElement !== d && !d.dataset.focused) { d.dataset.focused = '1'; d.focus() }
  }

  // ------------------------------------------------------------------------------------------------
  // Data
  // ------------------------------------------------------------------------------------------------

  async function refreshState() {
    try { S.st = await H.call('state'); S.banner = null } catch { /* the helper restarts */ }
    render()
  }
  async function loadAgents() {
    S.agentsBusy = true
    render()
    try { const r = await H.call('agents'); if (r && Array.isArray(r.r)) S.agents = r.r } catch { /* keep the old list */ }
    S.agentsBusy = false
    render()
  }
  async function loadVoice() {
    try { S.voice = await H.call('voiceStatus') } catch { /* later */ }
    render()
  }

  /** run a command of the bridge; its printed lines go to Details */
  async function run(key, method, params) {
    S.busy[key] = true
    render()
    let r = null
    try { r = await H.call(method, params) } catch (e) { S.lines.push(String(e && e.message ? e.message : e)) }
    S.busy[key] = false
    await refreshState()
    return r
  }

  /** a two-click button: the first click arms it for 4 s */
  function armed(key) {
    if (S.armed[key]) { S.armed[key] = false; return true }
    S.armed[key] = true
    setTimeout(() => { S.armed[key] = false; render() }, 4000)
    render()
    return false
  }

  const ACTIONS = {
    async getCode() {
      S.pair.starting = true
      S.pair.startErr = null
      S.pair.mismatch = null
      S.pair.digits = ''
      render()
      try {
        const r = await H.call('pairStart')
        if (r && !r.ok && r.why === 'setup') S.pair.startErr = (r.lines || []).join(' ')
      } catch (e) { S.pair.startErr = String(e && e.message ? e.message : e) }
      S.pair.starting = false
      await refreshState()
    },
    async cancelPair() { await H.call('pairCancel'); await refreshState() },
    async openPanel() { await H.app('openPanel') },
    async copyCode() {
      const p = S.st && S.st.pairing
      if (!p || !p.pretty) return
      await H.app('copyCode', p.pretty)
      S.pair.copied = true
      render()
      setTimeout(() => { S.pair.copied = false; render() }, 1500)
    },
    async confirmDigits() {
      const digits = S.pair.digits
      if (digits.length !== 4) return
      S.pair.digits = ''
      render()
      await H.call('pairCheck', { digits })
    },
    async startService() { await run('service', 'start') },
    async unpair() { if (armed('unpair')) await run('unpair', 'unpair') },
    async toggleAway() {
      const on = !!(S.st && S.st.service && S.st.service.away && S.st.service.away.on)
      await run('away', 'away', { on: !on })
    },
    async toggleRemote(el) { await run('remote', 'remoteAway', { on: !!el.checked }) },
    async refreshAgents() { await loadAgents() },
    async connect(el) {
      const id = el.dataset.id
      S.msg[id] = null
      const r = await run(id, 'install', { agent: id, askShell: id === 'grok' ? S.askShell : false })
      S.msg[id] = r && r.code === 0 ? 'ok' : 'bad'
      await loadAgents()
    },
    async disconnect(el) {
      const id = el.dataset.id
      S.msg[id] = null
      const r = await run(id, 'uninstall', { agent: id })
      S.msg[id] = r && r.code === 0 ? 'ok' : 'bad'
      await loadAgents()
    },
    askShell(el) { S.askShell = !!el.checked; render() },
    async voiceInstall() {
      S.voiceMsg = null
      S.voiceProg = null
      const r = await run('voice', 'voiceInstall')
      S.voiceMsg = r && r.code === 0 ? 'ok' : 'bad'
      await loadVoice()
    },
    async voiceRemove() { await run('voice', 'voiceRemove'); await loadVoice() },
    async autostart(el) { const r = await H.app('setOpenAtLogin', !!el.checked); S.info.openAtLogin = r.openAtLogin; render() },
    async lang(el) {
      const r = await H.app('setLang', el.value || null)
      S.info.lang = el.value || null
      S.lang = r.lang
      render()
    },
    purge(el) { S.purge = !!el.checked; render() },
    async removeAll() {
      if (!armed('remove')) return
      const r = await run('remove', 'uninstallAll', { purge: S.purge })
      S.removed = !!(r && r.code === 0)
      S.msg = {}
      // the app turned its sign-in start off with everything else
      try { S.info = await H.app('info') } catch { /* keep */ }
      await loadAgents()
      await loadVoice()
    },
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]')
    if (!el || el.disabled) return
    const act = el.dataset.act
    if (el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type === 'checkbox')) return
    if (ACTIONS[act]) { e.preventDefault(); ACTIONS[act](el) }
  })
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-act]')
    if (!el) return
    if ((el.tagName === 'SELECT' || el.type === 'checkbox') && ACTIONS[el.dataset.act]) ACTIONS[el.dataset.act](el)
  })
  document.addEventListener('input', (e) => {
    const el = e.target
    if (el.dataset && el.dataset.input === 'digits') {
      const v = el.value.replace(/\D/g, '').slice(0, 4)
      if (v !== el.value) el.value = v
      S.pair.digits = v
      const btn = document.querySelector('[data-act="confirmDigits"]')
      if (btn) btn.disabled = v.length !== 4
    }
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset && e.target.dataset.input === 'digits') ACTIONS.confirmDigits()
  })

  H.onState((st) => { S.st = st; render() })
  H.onEvent((ev, d) => {
    if (ev === 'line') {
      S.lines.push(String(d && d.text))
      if (S.lines.length > 400) S.lines.splice(0, S.lines.length - 400)
      render()
    } else if (ev === 'pair') {
      if (d && d.stage === 'mismatch') S.pair.mismatch = d.left
      if (d && (d.stage === 'end' || d.stage === 'code')) S.pair.mismatch = null
      if (d && d.stage === 'end' && d.ok) { loadAgents() }
      refreshState()
    } else if (ev === 'voice') {
      S.voiceProg = d
      render()
    } else if (ev === 'helper_down') {
      S.banner = t('helper_down')
      render()
    } else if (ev === 'ready') {
      S.banner = null
      refreshState(); loadVoice()
      if (!S.agents) loadAgents()
    }
  })

  ;(async () => {
    try { S.info = await H.app('info') } catch { S.info = null }
    S.lang = (S.info && (S.info.lang || S.info.systemLang)) || 'en'
    render()
    await refreshState()
    loadVoice()
    loadAgents()
  })()
})()
