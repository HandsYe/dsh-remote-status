// dsh-remote-status — client side.
//
// Renders a status chip in the sidebar footer showing whether the current
// session is local or remote («本地» / «远程 · 机器名»), and automatically
// renames default-named mirror workspaces to «目录名 ⇄ 机器名».
//
// Data comes from the plugin's own host routes (/dsh-remote-status/*), which
// read the dsh-remote data sources (machines.json + .dsh-remote-meta.json).
//
// Client entries must be classic scripts registered via window.__ModuleLoader__.load
window.__ModuleLoader__.load({
  id: 'dsh-remote-status',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const name = 'dsh-remote-status'

    function apiPath(path) {
      return window.location && window.location.protocol === 'dsh-app:'
        ? '/api' + path : path
    }

    async function api(method, path, body) {
      const opts = { method, headers: {} }
      if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
      const res = await fetch(apiPath(path), opts)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data && (data.error || data.message)) || 'HTTP ' + res.status)
      return data
    }

    // ── 本地/远程状态芯片 + 工作区标题标记 ──────────────────────────────
    const PILL_STATE = {
      session: '',
      mode: 'local',
      sessionRemotePath: '',
      currentId: null,
      machines: [],
      updatedAt: 0,
      lastError: '',
      ok: false,
    }
    const PILL_WARN = { workspaces: false, sessions: false }
    const PILL_LISTENERS = new Set()
    let SESSIONS = null
    let PILL_CTX = null
    let sweepTimer = 0
    let pillDebounceTimer = 0

    const notifyPill = () => { for (const fn of PILL_LISTENERS) try { fn() } catch (e) { /* ignore */ } }

    function schedulePillRefresh() {
      if (pillDebounceTimer) clearTimeout(pillDebounceTimer)
      pillDebounceTimer = setTimeout(() => { pillDebounceTimer = 0; pillRefresh() }, 150)
    }

    function pillWireEvents() {
      // 会话/工作区变化（切换目录、切换会话）→ 立即刷新，无需等下一轮询
      try {
        const s = SESSIONS
        if (s && s.list && typeof s.list.subscribe === 'function' && !s.list.__pillWired) {
          s.list.subscribe(schedulePillRefresh)
          s.list.__pillWired = true
        }
      } catch (e) { /* ignore */ }
      try {
        const w = serviceOf(PILL_CTX, 'workspaces')
        if (w && w.list && typeof w.list.subscribe === 'function' && !w.list.__pillWired) {
          w.list.subscribe(schedulePillRefresh)
          w.list.__pillWired = true
        }
      } catch (e) { /* ignore */ }
    }

    const serviceOf = (ctx, serviceName) => {
      try {
        const v = ctx && typeof ctx.get === 'function' ? ctx.get(serviceName) : null
        if (v !== void 0 && v !== null) return v
      } catch (e) { /* service unavailable */ }
      try {
        const v = ctx ? ctx[serviceName] : null
        if (v !== void 0 && v !== null) return v
      } catch (e) { /* service unavailable */ }
      return null
    }

    const pillMachineName = (machines, id) => {
      if (!id) return ''
      const m = (machines || []).find((x) => x && x.id === id)
      return (m && (m.name || m.host)) || String(id)
    }

    function pillCurrentSessionId() {
      try {
        if (!SESSIONS || !SESSIONS.list || typeof SESSIONS.list.getSnapshot !== 'function') return ''
        const snap = SESSIONS.list.getSnapshot()
        const byId = (snap && snap.byId) || {}
        const keys = Object.keys(byId)
        if (!keys.length) return ''
        const cur = (snap && (snap.current || (Array.isArray(snap.order) && snap.order[0]))) || keys[0]
        return (byId[cur] && cur) || keys[0]
      } catch (e) { return '' }
    }

    async function pillRefresh() {
      const sid = pillCurrentSessionId()
      PILL_STATE.session = sid
      try {
        const st = await api('GET', '/dsh-remote-status/status' + (sid ? '?sessionId=' + encodeURIComponent(sid) : ''))
        PILL_STATE.mode = st.sessionMode || 'local'
        PILL_STATE.sessionRemotePath = st.sessionRemotePath || ''
        PILL_STATE.currentId = st.currentId || null
        PILL_STATE.ok = true
      } catch (e) {
        PILL_STATE.lastError = String((e && e.message) || e)
        PILL_STATE.ok = false
      }
      try {
        const r = await api('GET', '/dsh-remote-status/machines').catch(() => null)
        if (r && Array.isArray(r.machines)) {
          PILL_STATE.machines = r.machines
          if (r.currentId) PILL_STATE.currentId = r.currentId
        }
      } catch (e) { /* keep last-known machines */ }
      PILL_STATE.updatedAt = Date.now()
      notifyPill()
      scheduleTitleSweep()
    }

    function pillText() {
      const label = pillMachineName(PILL_STATE.machines, PILL_STATE.currentId)
      if (PILL_STATE.mode === 'remote') return '远程 · ' + (label || '机器')
      if (PILL_STATE.mode === 'standby') return '远程机待命 · ' + (label || '—')
      return '本地'
    }

    function RemoteStatusPill(props) {
      // 订阅 PILL_STATE 变更：任何刷新（事件/轮询）后强制重渲染 → 秒变
      const [, setTick] = React.useState(0)
      React.useEffect(() => {
        const bump = () => setTick((x) => x + 1)
        PILL_LISTENERS.add(bump)
        return () => PILL_LISTENERS.delete(bump)
      }, [])
      const wide = props && props.wide
      const label = pillText()
      const isRemote = PILL_STATE.mode === 'remote' || PILL_STATE.mode === 'standby'
      const diagBase = [
        'workspaces 服务：' + (PILL_WARN.workspaces ? '正常' : '缺失'),
        'sessions 服务：' + (PILL_WARN.sessions ? '正常' : '缺失'),
        '状态接口：' + (PILL_STATE.ok ? '正常' : '失败'),
        '当前会话：' + (PILL_STATE.session || '—'),
        '会话模式：' + PILL_STATE.mode + (PILL_STATE.sessionRemotePath ? '（' + PILL_STATE.sessionRemotePath + '）' : ''),
      ]
      const diagMachine = isRemote ? [
        '当前机器：' + (PILL_STATE.currentId ? pillMachineName(PILL_STATE.machines, PILL_STATE.currentId) : '无'),
        '机器列表：' + String(PILL_STATE.machines.length) + ' 台',
      ] : ['当前会话不在任何远程镜像中——不涉及远程机器。']
      const diag = diagBase.concat(diagMachine, [
        '最近刷新：' + (PILL_STATE.updatedAt ? new Date(PILL_STATE.updatedAt).toLocaleTimeString() : '—'),
        PILL_STATE.lastError ? '最近错误：' + PILL_STATE.lastError : '',
        '',
        '「名称 ⇄ 机器名」的标题由工作区列表自动标记，仅针对默认命名。',
      ]).filter(Boolean).join('\n')
      if (!wide) {
        const remote = PILL_STATE.mode === 'remote'
        return React.createElement('div', {
          title: (remote ? '远程' : '本地') + (remote && PILL_STATE.currentId ? ' · ' + pillMachineName(PILL_STATE.machines, PILL_STATE.currentId) : '') + '\n' + diag,
          style: { width: 26, height: 26, borderRadius: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'help', fontSize: 13, lineHeight: 1, background: remote ? 'rgba(217,119,6,.15)' : 'rgba(34,197,94,.13)', color: remote ? '#d97706' : '#22c55e', border: '1px solid ' + (remote ? 'rgba(217,119,6,.35)' : 'rgba(34,197,94,.3)') },
        }, remote ? '⇄' : '◉')
      }
      return React.createElement('div', {
        title: diag,
        style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 10, fontSize: 11, lineHeight: 1.6, whiteSpace: 'nowrap', cursor: 'help', background: 'rgba(127,127,127,.08)', border: '1px solid rgba(127,127,127,.18)', color: 'inherit' },
      },
        React.createElement('span', { style: { fontWeight: 600, color: PILL_STATE.mode === 'remote' ? '#d97706' : '#22c55e' } }, PILL_STATE.mode === 'remote' ? '⇄' : '◉'),
        React.createElement('span', {}, label),
        (!PILL_WARN.workspaces || !PILL_STATE.ok) ? React.createElement('span', { style: { color: '#d97706' } }, '⚠') : null,
      )
    }

    async function sweepOnce() {
      const ws = serviceOf(PILL_CTX, 'workspaces')
      PILL_WARN.workspaces = !!ws
      PILL_WARN.sessions = !!SESSIONS || !!(PILL_CTX && typeof PILL_CTX.get === 'function' && PILL_CTX.get('sessions'))
      if (!ws || !ws.list || typeof ws.list.getSnapshot !== 'function') return
      let items = []
      try { items = ws.list.getSnapshot().items || [] } catch (e) { return }
      const machineLabel = pillMachineName(PILL_STATE.machines, PILL_STATE.currentId)
      for (const item of items) {
        if (!item) continue
        const title = (item.title || '').trim()
        const p = item.path || item.dir || item.id || ''
        const base = String(p).split(/[\\/]/).pop() || ''
        if (!base || title !== base) continue // 只标记默认命名的工作区
        try {
          const r = await api('GET', '/dsh-remote-status/resolve-mirror?local=' + encodeURIComponent(p)).catch(() => null)
          if (!r || !r.remotePath) continue
          const next = base + ' ⇄ ' + (machineLabel || '远程')
          try { await ws.rename(item.id, next) } catch (e) {
            try { await ws.list.rename(item.id, next) } catch (e2) { /* skip this round */ }
          }
        } catch (e) { /* skip this round */ }
      }
    }

    function scheduleTitleSweep() {
      if (sweepTimer) return
      sweepTimer = setTimeout(() => { sweepTimer = 0; sweepOnce() }, 600)
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      // 会话服务（供会话判定与事件订阅）
      ctx.inject(['sessions'], (inner) => {
        const sessions = inner.get('sessions')
        SESSIONS = sessions
        inner.effect(() => () => { if (SESSIONS === sessions) SESSIONS = null }, 'dsh-remote-status.sessions')
      })
      // 状态芯片：侧边栏底部显示 本地/远程·机器名
      PILL_CTX = ctx
      pillRefresh()
      pillWireEvents()
      ctx.inject(['slots'], (inner) => {
        inner.effect(() => {
          const pillTimer = setInterval(pillRefresh, 1000)
          return () => clearInterval(pillTimer)
        }, 'dsh-remote-status.status-pill')
      })
      slots.inject('sidebar.footer.action', () =>
        slots.register({ name: 'sidebar.footer.action', id: 'dsh-remote-status', priority: 10 }, RemoteStatusPill),
      )
    }

    exports.name = name
    exports.inject = ['slots']
    exports.apply = apply
    exports._hooks_test = { refreshPill: () => pillRefresh(), pillText: () => pillText(), sweepOnce: () => sweepOnce(), state: PILL_STATE }
    return module.exports
  },
})
