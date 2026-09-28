// dsh-remote-status — client side.
//
// Renders a status chip in the sidebar footer showing whether the current
// session is local or remote («本地» / «远程 · 机器名»).
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

    // ── 本地/远程状态芯片 ─────────────────────────────────────────────
    const PILL_STATE = {
      session: '',
      mode: 'unknown',
      sessionRemotePath: '',
      sessionMachineId: null,
      sessionMachineName: '',
      sessionHostDir: '',
      currentId: null,
      machines: [],
      updatedAt: 0,
      lastError: '',
      ok: false,
    }
    const PILL_LISTENERS = new Set()
    let SESSIONS = null
    let PILL_LAYOUT = null
    let pillDebounceTimer = 0
    let pillRefreshId = 0

    const notifyPill = () => { for (const fn of PILL_LISTENERS) try { fn() } catch (e) { /* ignore */ } }

    function schedulePillRefresh() {
      if (pillDebounceTimer) clearTimeout(pillDebounceTimer)
      pillDebounceTimer = setTimeout(() => { pillDebounceTimer = 0; pillRefresh() }, 150)
    }

    function subscribePill(service) {
      if (service && service.list && typeof service.list.subscribe === 'function') {
        return service.list.subscribe(schedulePillRefresh)
      }
      return () => {}
    }

    const pillMachineName = (machines, id) => {
      if (!id) return ''
      const m = (machines || []).find((x) => x && x.id === id)
      return (m && (m.name || m.host)) || String(id)
    }

    function pillCurrentSessionId() {
      try {
        if (!SESSIONS || !SESSIONS.list || typeof SESSIONS.list.getSnapshot !== 'function') return ''
        const panelInfo = PILL_LAYOUT && PILL_LAYOUT.panelInfo
        if (panelInfo && typeof panelInfo.getSnapshot === 'function') {
          const panel = panelInfo.getSnapshot()
          if (panel && panel.activePanelId !== null && panel.activePanelId !== undefined) return ''
        }
        const snap = SESSIONS.list.getSnapshot()
        const byId = (snap && snap.byId) || {}
        const rows = Object.values(byId).filter(Boolean)
        // DSH 2.0.15 marks the visible conversation with mainView retention.
        // List order includes other workspaces and background sessions, not selection.
        const main = rows.filter((row) => row.retainedBy && row.retainedBy.mainView > 0)
        if (main.length === 1) return main[0].id || ''
        if (rows.some((row) => row.retainedBy !== undefined)) return ''
        // Older clients may expose an explicit current id. Never guess from order.
        return snap && typeof snap.current === 'string' && byId[snap.current] ? snap.current : ''
      } catch (e) { return '' }
    }

    async function pillRefresh() {
      const sid = pillCurrentSessionId()
      const requestId = ++pillRefreshId
      const isCurrent = () => requestId === pillRefreshId && sid === pillCurrentSessionId()
      if (PILL_STATE.session !== sid) {
        // A new directory must never inherit a previous directory's server label.
        Object.assign(PILL_STATE, {
          session: sid, mode: 'unknown', sessionRemotePath: '', sessionMachineId: null,
          sessionMachineName: '', sessionHostDir: '', ok: false, lastError: '', updatedAt: 0,
        })
        notifyPill()
      }
      if (!sid) {
        Object.assign(PILL_STATE, {
          session: '', mode: 'unknown', sessionRemotePath: '', sessionMachineId: null,
          sessionMachineName: '', sessionHostDir: '', ok: false, lastError: '',
        })
        notifyPill()
        return
      }
      try {
        const st = await api('GET', '/dsh-remote-status/status?sessionId=' + encodeURIComponent(sid))
        if (!isCurrent()) return
        PILL_STATE.mode = st.sessionMode || 'unknown'
        PILL_STATE.sessionRemotePath = st.sessionRemotePath || ''
        PILL_STATE.sessionMachineId = st.sessionMachineId || null
        PILL_STATE.sessionMachineName = st.sessionMachineName || ''
        PILL_STATE.sessionHostDir = st.sessionHostDir || ''
        PILL_STATE.currentId = st.currentId || null
        PILL_STATE.ok = true
        PILL_STATE.lastError = ''
      } catch (e) {
        if (!isCurrent()) return
        PILL_STATE.lastError = String((e && e.message) || e)
        PILL_STATE.ok = false
      }
      try {
        const r = await api('GET', '/dsh-remote-status/machines').catch(() => null)
        if (!isCurrent()) return
        if (r && Array.isArray(r.machines)) {
          PILL_STATE.machines = r.machines
          PILL_STATE.currentId = r.currentId || null
        }
      } catch (e) { /* keep last-known machines */ }
      if (!isCurrent()) return
      PILL_STATE.updatedAt = Date.now()
      notifyPill()
    }

    function pillText() {
      // A connected/global machine says nothing about the visible directory.
      const label = PILL_STATE.sessionMachineName ||
        pillMachineName(PILL_STATE.machines, PILL_STATE.sessionMachineId) || PILL_STATE.sessionHostDir
      if (PILL_STATE.mode === 'remote') return '远程 · ' + (label || '未知机器')
      if (PILL_STATE.mode === 'local') return '本地'
      return PILL_STATE.session ? '状态待确认' : '未选择会话'
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
      const isRemote = PILL_STATE.mode === 'remote'
      const diagBase = [
        '状态接口：' + (PILL_STATE.ok ? '正常' : '失败'),
        '当前会话：' + (PILL_STATE.session || '—'),
        '会话模式：' + PILL_STATE.mode + (PILL_STATE.sessionRemotePath ? '（' + PILL_STATE.sessionRemotePath + '）' : ''),
      ]
      const diagMachine = PILL_STATE.mode === 'remote' ? [
        '会话机器：' + (PILL_STATE.sessionMachineName || PILL_STATE.sessionHostDir || '未知'),
        '当前机器：' + (PILL_STATE.currentId ? pillMachineName(PILL_STATE.machines, PILL_STATE.currentId) : '无'),
        '机器列表：' + String(PILL_STATE.machines.length) + ' 台',
      ] : [PILL_STATE.mode === 'local' ? '当前会话不在任何远程镜像中——不涉及远程机器。' : '尚未确认当前会话的目录归属。']
      const diag = diagBase.concat(diagMachine, [
        '最近刷新：' + (PILL_STATE.updatedAt ? new Date(PILL_STATE.updatedAt).toLocaleTimeString() : '—'),
        PILL_STATE.lastError ? '最近错误：' + PILL_STATE.lastError : '',
        '',
      ]).filter(Boolean).join('\n')
      if (!wide) {
        const remote = PILL_STATE.mode === 'remote'
        return React.createElement('div', {
          title: label + '\n' + diag,
          style: { width: 26, height: 26, borderRadius: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'help', fontSize: 13, lineHeight: 1, background: remote ? 'rgba(217,119,6,.15)' : 'rgba(34,197,94,.13)', color: remote ? '#d97706' : '#22c55e', border: '1px solid ' + (remote ? 'rgba(217,119,6,.35)' : 'rgba(34,197,94,.3)') },
        }, remote ? '⇄' : PILL_STATE.mode === 'local' ? '◉' : '?')
      }
      return React.createElement('div', {
        title: diag,
        // Desktop 2.0.11 injects `body [data-slot="sidebar.footer.action"]{flex-direction:column;align-items:center}`
        // to stack launchers, which centers this chip. alignSelf:flex-start restores
        // the previous left-aligned seat (cross axis = horizontal in a column flex).
        // Collapsed rail keeps the parent's centering for the round dot.
        style: { alignSelf: wide ? 'flex-start' : undefined, display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 10, fontSize: 11, lineHeight: 1.6, whiteSpace: 'nowrap', cursor: 'help', background: 'rgba(127,127,127,.08)', border: '1px solid rgba(127,127,127,.18)', color: 'inherit' },
      },
        React.createElement('span', { style: { fontWeight: 600, color: PILL_STATE.mode === 'remote' ? '#d97706' : '#22c55e' } }, PILL_STATE.mode === 'remote' ? '⇄' : PILL_STATE.mode === 'local' ? '◉' : '?'),
        React.createElement('span', {}, label),
        !PILL_STATE.ok ? React.createElement('span', { style: { color: '#d97706' } }, '⚠') : null,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      // Services may arrive late or be replaced; subscriptions belong to their lifetime.
      ctx.inject(['sessions'], (inner) => {
        const sessions = inner.get('sessions')
        SESSIONS = sessions
        inner.effect(() => {
          const stop = subscribePill(sessions)
          schedulePillRefresh()
          return () => {
            if (typeof stop === 'function') stop()
            if (SESSIONS === sessions) SESSIONS = null
          }
        }, 'dsh-remote-status.sessions')
      })
      ctx.inject(['layout'], (inner) => {
        const layout = inner.get('layout')
        PILL_LAYOUT = layout
        inner.effect(() => {
          const source = layout && layout.panelInfo
          const stop = source && typeof source.subscribe === 'function' ? source.subscribe(schedulePillRefresh) : null
          schedulePillRefresh()
          return () => {
            if (typeof stop === 'function') stop()
            if (PILL_LAYOUT === layout) PILL_LAYOUT = null
          }
        }, 'dsh-remote-status.layout')
      })
      // 状态芯片：侧边栏底部显示 本地/远程·机器名
      pillRefresh()
      ctx.inject(['slots'], (inner) => {
        inner.effect(() => {
          const pillTimer = setInterval(pillRefresh, 1000)
          return () => {
            clearInterval(pillTimer)
            clearTimeout(pillDebounceTimer)
            pillDebounceTimer = 0
            pillRefreshId++
          }
        }, 'dsh-remote-status.status-pill')
      })
      slots.inject('sidebar.footer.action', () =>
        slots.register({ name: 'sidebar.footer.action', id: 'dsh-remote-status', priority: 10 }, RemoteStatusPill),
      )
    }

    exports.name = name
    exports.inject = ['slots']
    exports.apply = apply
    exports._hooks_test = { refreshPill: () => pillRefresh(), pillText: () => pillText(), state: PILL_STATE }
    return module.exports
  },
})
