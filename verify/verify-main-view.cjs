// Contract regression: DSH 2.0.15 sessions.ids/byId + retainedBy.mainView.
// Runs the real client against the real host routes through Connection Fetch.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-main-view-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = temp
  let checks = 0
  function check(condition, message) { assert.ok(condition, message); checks++; console.log('✓ ' + message) }
  try {
    const root = path.join(temp, 'remote-workspaces')
    const local = path.join(temp, 'local-project')
    const a = path.join(root, '192.0.2.1-root-22', 'api')
    const b = path.join(root, '192.0.2.2-dev-22', 'data')
    for (const dir of [local, a, b]) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(a, '.dsh-remote-meta.json'), JSON.stringify({ host: '192.0.2.1', username: 'root', port: 22, remotePath: '/srv/api' }))
    fs.writeFileSync(path.join(b, '.dsh-remote-meta.json'), JSON.stringify({ host: '192.0.2.2', username: 'dev', port: 22, remotePath: '/srv/data' }))
    fs.writeFileSync(path.join(root, 'machines.json'), JSON.stringify({ currentId: 'a', list: [
      { id: 'a', name: '广州服务器', host: '192.0.2.1', username: 'root', port: 22 },
      { id: 'b', name: '潮州服务器', host: '192.0.2.2', username: 'dev', port: 22 },
    ] }))
    const snapshot = { ids: ['remote-a', 'local', 'remote-b'], byId: {
      'remote-a': { id: 'remote-a', cwd: a, retainedBy: { background: 1 } },
      local: { id: 'local', cwd: local, retainedBy: { mainView: 1 } },
      'remote-b': { id: 'remote-b', cwd: b, retainedBy: {} },
    } }
    const hostRoutes = new Map()
    const { apply } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href)
    await apply({
      get(name) { return name === 'sessions' ? { get(id) { const s = snapshot.byId[id]; return s && { header: { cwd: s.cwd } } } } : null },
      inject(names, fn) {
        const services = {
          webServer: { register() { return () => {} } },
          connection: { fetch: { register(route) { hostRoutes.set(route.path, route); return () => {} } } },
        }
        fn({ get: (name) => services[name], effect: (f) => f() })
      },
    })
    const timers = new Map()
    const subscribers = new Set()
    const panelSubscribers = new Set()
    const panel = { activePanelId: null }
    const workspaces = [
      { workspaceId: 'wa', path: a, title: 'api' },
      { workspaceId: 'wb', path: b, title: 'data' },
      { workspaceId: 'wl', path: local, title: 'local-project' },
      { workspaceId: 'custom', path: b, title: 'Custom title' },
    ]
    const renames = []
    const requested = []
    const disposers = []
    let sequence = 0, exported, component, fail = false, hold = null, held = null, missingOwner = false
    const services = {
      slots: { inject(name, fn) { fn() }, register(def, comp) { component = comp; return () => {} } },
      sessions: { list: { getSnapshot: () => snapshot, subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn) } } },
      layout: { panelInfo: { getSnapshot: () => panel, subscribe(fn) { panelSubscribers.add(fn); return () => panelSubscribers.delete(fn) } } },
      workspaces: {
        list: { getSnapshot: () => ({ items: workspaces }), subscribe() { return () => {} } },
        rename() {
          renames.push(['must-never-happen'])
          assert.fail('this plugin must never rename workspaces')
        },
      },
    }
    const react = { createElement: (type, props, ...children) => ({ type, props, children }), useState: () => [0, () => {}], useEffect() {} }
    const sandbox = {
      window: { location: { protocol: 'dsh-app:' }, __ModuleLoader__: { load({ factory }) { exported = factory((name) => { assert.equal(name, 'react'); return react }) } } },
      console, URL,
      setTimeout(fn) { const id = ++sequence; timers.set(id, fn); return id }, clearTimeout(id) { timers.delete(id) },
      setInterval() { return ++sequence }, clearInterval() {},
      async fetch(url) {
        const u = new URL(url, 'http://plugin.local')
        assert.ok(u.pathname.startsWith('/api/dsh-remote-status/'), 'desktop uses Connection prefix')
        if (u.pathname.endsWith('/status')) {
          const id = u.searchParams.get('sessionId'); requested.push(id)
          if (fail) return Response.json({ error: 'offline' }, { status: 503 })
          const response = await hostRoutes.get(u.pathname).fetch(new Request(u))
          if (missingOwner) {
            const body = await response.json()
            Object.assign(body, { sessionMachineName: '', sessionMachineId: null, sessionHostDir: '' })
            return Response.json(body)
          }
          if (hold === id) return new Promise((resolve) => { held = () => resolve(response) })
          return response
        }
        return hostRoutes.get(u.pathname).fetch(new Request(u))
      },
    }
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8'), sandbox)
    exported.apply({ get: (name) => services[name], inject(names, fn) { fn({ get: (name) => services[name], effect(f) { const dispose = f(); if (dispose) disposers.push(dispose) } }) } })
    const h = exported._hooks_test
    function select(id) {
      for (const row of Object.values(snapshot.byId)) row.retainedBy = row.id === id ? { mainView: 1 } : {}
    }
    await h.refreshPill()
    check(h.state.session === 'local' && h.pillText() === '本地', 'first row/global machine Guangzhou cannot override selected local session')
    check(!component({ wide: false }).props.title.includes('广州服务器'), 'collapsed local tooltip never borrows global machine')
    check(component({ wide: true }).props.style.alignSelf === 'flex-start', 'expanded chip remains left-aligned')
    check(!component({ wide: false }).props.style.alignSelf, 'collapsed chip keeps parent centering')
    select('remote-b'); await h.refreshPill()
    check(h.pillText() === '远程 · 潮州服务器', 'mainView selects the second server independently of global Guangzhou')
    check(component({ wide: false }).props.title.split('\n')[0] === '远程 · 潮州服务器', 'collapsed headline uses the session machine too')
    select('local'); for (const fn of subscribers) fn()
    for (const [id, fn] of [...timers]) { timers.delete(id); fn() }
    await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve))
    check(h.state.session === 'local' && h.pillText() === '本地', 'mainView subscription refreshes selection without the polling timer')
    snapshot.current = 'remote-a'; snapshot.order = ['remote-a']; select('local'); await h.refreshPill()
    check(h.pillText() === '本地', 'mainView wins over stale legacy current and order fields')
    select(''); const before = requested.length; await h.refreshPill()
    check(h.pillText() === '未选择会话' && requested.length === before, 'no mainView does not choose the first row or query unscoped status')
    select('local'); snapshot.byId['remote-a'].retainedBy.mainView = 1; await h.refreshPill()
    check(h.state.session === '', 'transient multiple mainView references are not guessed')
    for (const row of Object.values(snapshot.byId)) delete row.retainedBy
    snapshot.current = 'local'; await h.refreshPill()
    check(h.pillText() === '本地', 'legacy explicit current remains compatible')
    delete snapshot.current; await h.refreshPill()
    check(h.state.session === '', 'legacy order alone is never treated as selection')
    delete snapshot.order
    select('remote-a'); await h.refreshPill(); fail = true
    select('local'); await h.refreshPill()
    check(h.pillText() === '状态待确认' && !h.state.sessionMachineName, 'new-session fetch failure clears the previous server')
    fail = false; await h.refreshPill()
    check(h.pillText() === '本地' && !h.state.lastError, 'recovery clears error and resolves the local session')
    fail = true; await h.refreshPill()
    check(h.pillText() === '本地' && !h.state.ok, 'same-session failure retains only its own last known state')
    fail = false
    select('remote-b'); hold = 'remote-b'
    const older = h.refreshPill()
    while (!held) await new Promise((resolve) => setImmediate(resolve))
    hold = null; select('local'); await h.refreshPill(); held(); await older
    check(h.state.session === 'local' && h.pillText() === '本地', 'late remote response cannot overwrite newer local selection')
    held = null; hold = 'remote-a'; select('remote-a'); const pending = h.refreshPill()
    while (!held) await new Promise((resolve) => setImmediate(resolve))
    hold = null; select('local'); held(); await pending
    check(h.state.mode === 'unknown' && !h.state.sessionMachineName, 'selection changed before next refresh still rejects the stale response')
    await h.refreshPill()
    select('remote-b'); missingOwner = true; await h.refreshPill()
    check(h.pillText() === '远程 · 未知机器', 'unmatched remote machine never falls back to global Guangzhou')
    check(!component({ wide: false }).props.title.split('\n')[0].includes('广州'), 'unmatched collapsed headline does not leak global machine')
    missingOwner = false
    select('remote-b'); await h.refreshPill()
    panel.activePanelId = 'settings'
    for (const fn of panelSubscribers) fn()
    for (const [id, fn] of [...timers]) { timers.delete(id); fn() }
    await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve))
    check(h.state.session === '' && h.pillText() === '未选择会话', 'opening another panel hides the retained background conversation')
    check(component({ wide: false }).children.includes('?'), 'unknown collapsed state is not presented as confirmed local')
    panel.activePanelId = null
    for (const fn of panelSubscribers) fn()
    for (const [id, fn] of [...timers]) { timers.delete(id); fn() }
    await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve))
    check(h.pillText() === '远程 · 潮州服务器', 'returning to the conversation refreshes through panel subscription')
    check(renames.length === 0, 'workspace titles are never renamed (no ownership suffix)')
    const registryPath = path.join(root, 'machines.json')
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
    registry.list.unshift(
      { id: 'wrong-user', name: 'Wrong user', host: '192.0.2.2', username: 'root', port: 22 },
      { id: 'wrong-port', name: 'Wrong port', host: '192.0.2.2', username: 'dev', port: 2222 },
    )
    fs.writeFileSync(registryPath, JSON.stringify(registry))
    await h.refreshPill()
    check(h.pillText() === '远程 · 潮州服务器', 'same host with other usernames or ports cannot steal the mirror name')
    registry.list.push({ ...registry.list.find((m) => m.id === 'b'), id: 'duplicate-b', name: 'Ambiguous name' })
    fs.writeFileSync(registryPath, JSON.stringify(registry))
    await h.refreshPill()
    check(!h.state.sessionMachineName && !h.pillText().includes('广州'), 'ambiguous machine aliases never guess from registry order')
    const literalPercent = path.join(b, '100% done')
    const resolved = await hostRoutes.get('/api/dsh-remote-status/resolve-mirror').fetch(new Request('http://plugin.local/api/dsh-remote-status/resolve-mirror?local=' + encodeURIComponent(literalPercent)))
    check(resolved.ok && (await resolved.json()).mode === 'remote', 'literal percent paths are URL-decoded exactly once')
    for (const dispose of disposers) dispose()
    check(panelSubscribers.size === 0 && timers.size === 0, 'panel subscription and scheduled timers are released on disposal')
    check(subscribers.size === 0 && !services.sessions.list.__pillWired, 'subscriptions are disposed without mutating the host store')
    console.log(`PASS: ${checks} main-view regression checks (real host + client; not a browser visual test)`)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
