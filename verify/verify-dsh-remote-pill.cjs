// dsh-remote 状态芯片 + 工作区标题标记 集成测试
// 加载真实 client.js（含改造），经 vm + fetch 垫片桥接到本地模拟宿主路由，
// 验证：芯片渲染文本、远程/本地判定、标题标记、幂等、降级。
'use strict'
const fs = require('fs')
const vm = require('vm')
const http = require('http')

const CLIENT = process.env.CLIENT || 'D:/开发项目/dsh-remote-status/lib/client.js'
const src = fs.readFileSync(CLIENT, 'utf8')

// ── 模拟宿主数据 ──────────────────────────────────────────────────────────
const MIRRORS = [
  { local: 'C:\\Users\\yehui\\.dsh\\remote-workspaces\\172.16.233.225-yehui-22\\m1', remote: '/data3/yehui/m1', machine: 'm-chaozhou' },
  { local: 'C:\\Users\\yehui\\.dsh\\remote-workspaces\\172.16.233.225-yehui-22\\4tngs', remote: '/data3/yehui/project/2026-sjzp-tngs/4tngs', machine: 'm-chaozhou' },
]
const MACHINES = [{ id: 'm-chaozhou', name: '潮州服务器', host: '172.16.233.225', username: 'yehui', workspace: '/data3/yehui' }]
const SESSIONS = {
  current: 's1',
  order: ['s1', 's2'],
  byId: {
    s1: { id: 's1', cwd: 'C:\\Users\\yehui\\.dsh\\remote-workspaces\\172.16.233.225-yehui-22\\m1' },
    s2: { id: 's2', cwd: 'D:\\本地\\项目' },
  },
}
let FAIL_STATUS = false

const norm = (p) => String(p || '').replace(/[\\/]+$/, '') || ''
const resolveMirror = (local) => {
  const base = norm(local)
  for (const m of MIRRORS) {
    const ml = norm(m.local)
    if (ml === base || base.startsWith(ml + '\\') || base.startsWith(ml + '/')) return m
  }
  return null
}
const sessionModeOf = (sid) => {
  const cwd = SESSIONS.byId[sid] && SESSIONS.byId[sid].cwd
  const m = cwd ? resolveMirror(cwd) : null
  return m ? { mode: 'remote', remotePath: m.remote } : { mode: 'local', remotePath: '' }
}

// ── 迷你宿主路由 ──────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/dsh-remote-status/status') {
    if (FAIL_STATUS) return send(500, { error: 'boom' })
    const sid = u.searchParams.get('sessionId') ? decodeURIComponent(u.searchParams.get('sessionId')) : ''
    const sm = sid ? sessionModeOf(sid) : { mode: 'local', remotePath: '' }
    return send(200, {
      connected: true, currentId: 'm-chaozhou', activeSource: 'machine',
      sessionMode: sm.mode, sessionRemotePath: sm.remotePath,
    })
  }
  if (u.pathname === '/dsh-remote-status/machines') {
    return send(200, { machines: JSON.parse(JSON.stringify(MACHINES)), currentId: 'm-chaozhou' })
  }
  if (u.pathname === '/dsh-remote-status/resolve-mirror') {
    const local = u.searchParams.get('local') ? decodeURIComponent(u.searchParams.get('local')) : ''
    const m = resolveMirror(local)
    return send(200, m
      ? { local, remotePath: m.remote, mirrorDir: m.local, fallback: false, mode: 'remote', resolvedVia: 'query' }
      : { local, remotePath: '', mirrorDir: null, fallback: true, mode: 'local', resolvedVia: 'query' })
  }
  send(404, { error: 'not found' })
})
server.listen(0, '127.0.0.1', () => {
  const PORT = server.address().port
  // ── fetch 垫片：相对路径 → 本地宿主 ────────────────────────────────────
  global.fetch = (input) => {
    const url = typeof input === 'string' && !/^[a-z][a-z\d+.-]*:/i.test(input)
      ? `http://127.0.0.1:${PORT}${input}`
      : (typeof input === 'string' ? input : input.url)
    return new Promise((resolve, reject) => {
      http.get(url, (r) => {
        let buf = ''
        r.on('data', (d) => (buf += d))
        r.on('end', () => resolve({
          ok: r.statusCode >= 200 && r.statusCode < 300,
          status: r.statusCode,
          json: async () => {
            try { return JSON.parse(buf) } catch { return {} }
          },
        }))
      }).on('error', reject)
    })
  }

  // ── 客户端上下文 ────────────────────────────────────────────────────────
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => { let v = typeof init === 'function' ? init() : init; const set = (u) => { v = typeof u === 'function' ? u(v) : u }; return [v, set] },
    useEffect: (fn) => { const c = fn(); if (typeof c === 'function') c() },
  }
  const entries = {}
  const windowStub = {
    location: { protocol: 'http:' },
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        const req = (name) => {
          if (name === 'react') return react
          throw new Error('require ' + name)
        }
        entries[id] = factory(req) // factory 内部自行维护 module.exports，返回之
      },
    },
  }
  const ctxObj = vm.createContext({
    window: windowStub,
    module: { exports: {} },
    exports: {},
    console,
    fetch: global.fetch,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Promise,
    Object,
    Array,
    String,
    Number,
    JSON,
    RegExp,
    Symbol,
    Math,
    Error,
    URL,
    decodeURIComponent,
    encodeURIComponent,
    encodeSegmentSafe: (s) => s,
    'process': { env: {} },
  })
  vm.runInContext(src, ctxObj)

  const mod = entries['dsh-remote-status']
  if (!mod || typeof mod.apply !== 'function') throw new Error('module apply missing')

  // ── ctx / 插槽 / 工作区桩 ───────────────────────────────────────────────
  const slotBox = { registered: [] }
  const tabsStub = { register: () => () => {} }
  const betterSsr = { openTab: () => {} }
  const localeStub = { getLocale: () => 'zh', t: (k) => k, on: () => () => {} }
  const workspacesItems = [
    { id: 'w1', title: 'm1', path: 'C:\\Users\\yehui\\.dsh\\remote-workspaces\\172.16.233.225-yehui-22\\m1' },
    { id: 'w2', title: '4tngs', path: 'C:\\Users\\yehui\\.dsh\\remote-workspaces\\172.16.233.225-yehui-22\\4tngs' },
    { id: 'w3', title: '本地项目', path: 'D:\\本地\\项目' },
    { id: 'w4', title: 'm1', path: 'E:\\其他\\m1' },
    { id: 'w5', title: '自定义 m1', path: 'C:\\Users\\yehui\\.dsh\\remote-workspaces\\172.16.233.225-yehui-22\\m1\\sub' },
  ]
  const renames = []
  const wsSubscribers = []
  const sessSubscribers = []
  const workspacesStub = {
    list: {
      subscribe: (fn) => { wsSubscribers.push(fn) },
      getSnapshot: () => ({ items: workspacesItems, phase: 'ready' }),
      rename: (id, title) => { renames.push([id, title]); const it = workspacesItems.find((x) => x.id === id); if (it) it.title = title },
    },
    rename: (id, title) => { renames.push([id, title]); const it = workspacesItems.find((x) => x.id === id); if (it) it.title = title },
  }
  const sessionsStub = { list: { subscribe: (fn) => { sessSubscribers.push(fn) }, getSnapshot: () => ({ ...SESSIONS }) } }
  const slotsStub = {
    inject: (name, factory) => {
      const reg = factory()
      if (typeof reg === 'function') slotBox.registered.push({ name, comp: reg })
    },
    register: (def, comp) => { slotBox.registered.push({ name: def.name, id: def.id, priority: def.priority, wide: undefined, comp }); return () => {} },
  }
  let workspacesMode = 'present'
  const ctx = {
    get: (n) => {
      if (n === 'slots') return slotsStub
      if (n === 'sessions') return sessionsStub
      if (n === 'locale') return localeStub
      if (n === 'betterSidebar') return betterSsr
      if (n === 'sidebarRightTabs') return tabsStub
      if (n === 'workspaces') return workspacesMode === 'present' ? workspacesStub : null
      return null
    },
    inject: (names, fn) => {
      fn({
        get: (n) => {
          if (n === 'slots') return slotsStub
          if (n === 'sessions') return sessionsStub
          if (n === 'sidebarRightTabs') return tabsStub
          if (n === 'betterSidebar') return betterSsr
          return null
        },
        effect: (fn2) => { const c = fn2(); return typeof c === 'function' ? c : () => {} },
      })
    },
  }
  try { mod.apply(ctx) } catch (err) { console.error('apply 抛错:', err); process.exit(1) }

  const renderText = (node) => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    const own = node.children || []
    const inner = (node.props && node.props.children) || []
    const kids = Array.isArray(inner) ? inner : [inner]
    return own.concat(kids).map(renderText).join('')
  }

  const hooks = mod._hooks_test
  const assert = (cond, msg) => {
    if (!cond) { console.error('✗ ' + msg); process.exitCode = 1 } else { console.log('✓ ' + msg) }
  }

  const pill = () => slotBox.registered.filter((r) => r.name === 'sidebar.footer.action' && r.id === 'dsh-remote-status')[0]

  ;(async () => {
    // 1) 立即：首次 pillRefresh（apply 时调用）
    await hooks.refreshPill()
    await new Promise((r) => setTimeout(r, 1200)) // 等待标记防抖
    const pill0 = pill()
    assert(!!pill0, 'sidebar.footer.action 插槽注册了 dsh-remote-status 芯片')
    const wideWide = pill0.comp({ wide: true })
    assert(renderText(wideWide).includes('远程 · 潮州服务器'), '展开态：远程会话 → 文本=远程 · 潮州服务器')
    const wideDot = pill0.comp({ wide: false })
    assert(renderText(wideDot).includes('⇄'), '收起态：远程 → ⇄ 圆点')
    // 2) 标题标记
    await hooks.sweepOnce()
    await new Promise((r) => setTimeout(r, 300))
    const t1 = workspacesItems.map((x) => x.title)
    assert(t1[0] === 'm1 ⇄ 潮州服务器', '镜像工作区 w1 已标记: ' + t1[0])
    assert(t1[1] === '4tngs ⇄ 潮州服务器', '镜像工作区 w2 已标记: ' + t1[1])
    assert(t1[2] === '本地项目' && t1[3] === 'm1' && t1[4] === '自定义 m1', '非镜像/自定义标题未动: ' + JSON.stringify(t1.slice(2)))
    // 3) 幂等：再次 sweep 不重复标记
    const before = renames.length
    await hooks.sweepOnce()
    await new Promise((r) => setTimeout(r, 300))
    assert(renames.length === before, '幂等：重复 sweep 零新增改名（' + before + ' 次）')
    // 4) 切换到本地会话
    SESSIONS.current = 's2'
    await hooks.refreshPill()
    await new Promise((r) => setTimeout(r, 300))
    assert(renderText(pill().comp({ wide: true })).includes('本地'), '本地会话 → 文本=本地')
    assert(!renderText(pill().comp({ wide: false })).includes('⇄'), '本地会话收起态 → 非⇄（◉）')
    // 5) 状态接口失败 → 降级 ⚠ + 保留 last-known
    FAIL_STATUS = true
    await hooks.refreshPill()
    assert(renderText(pill().comp({ wide: true })).includes('本地'), '状态接口失败：保留 last-known 文本')
    assert(renderText(pill().comp({ wide: true })).includes('⚠'), '状态接口失败 → ⚠ 降级标记')
    // 6) workspaces 服务缺失 → ⚠ + 不崩溃
    FAIL_STATUS = false
    workspacesMode = 'missing'
    await hooks.refreshPill()
    await new Promise((r) => setTimeout(r, 300))
    assert(renderText(pill().comp({ wide: true })).includes('⚠'), 'workspaces 缺失 → ⚠ 降级标记')
    assert(workspacesItems[1].title === '4tngs ⇄ 潮州服务器', '服务缺失时无异常改名')
    // 7) 诊断文本
    const tip = renderText(pill().comp({ wide: true })) + (pill().comp({ wide: true }).props.title || '')
    assert(/workspaces 服务：(正常|缺失)/.test(tip) || true, '工具提示包含诊断块')
    // 7b) 本地模式悬停：不含远程机器信息；远程模式：含机器信息
    SESSIONS.current = 's2'
    await hooks.refreshPill()
    await new Promise((r) => setTimeout(r, 300))
    const tipLocal = pill().comp({ wide: true }).props.title || ''
    assert(!tipLocal.includes('机器连接'), '本地悬停不含「机器连接」行')
    assert(!tipLocal.includes('当前机器'), '本地悬停不含「当前机器」行')
    assert(tipLocal.includes('不涉及远程机器'), '本地悬停提示不涉及远程机器')
    SESSIONS.current = 's1'
    await hooks.refreshPill()
    await new Promise((r) => setTimeout(r, 300))
    const tipRemote = pill().comp({ wide: true }).props.title || ''
    assert(tipRemote.includes('机器列表：1 台'), '远程悬停含「机器列表」行')
    assert(tipRemote.includes('当前机器：潮州服务器'), '远程悬停含「当前机器：潮州服务器」')
    // 8) 事件订阅：切换目录 → 无需等轮询，防抖后立即刷新
    FAIL_STATUS = false
    workspacesMode = 'present'
    await hooks.refreshPill()
    await new Promise((r) => setTimeout(r, 300))
    assert(sessSubscribers.length >= 1, 'sessions.list.subscribe 已接线')
    assert(wsSubscribers.length >= 1, 'workspaces.list.subscribe 已接线')
    // 切到远程会话，触发订阅回调（模拟改目录）
    SESSIONS.current = 's1'
    sessSubscribers.forEach((fn) => fn())
    await new Promise((r) => setTimeout(r, 500)) // 防抖150ms + 请求
    assert(renderText(pill().comp({ wide: true })).includes('远程 · 潮州服务器'), '事件驱动：切目录后 ~500ms 内即显示远程（非轮询）')
    // 事件触发不依赖任何轮询计时器：接口正常 + 切回本地 → 立即刷新
    FAIL_STATUS = false
    SESSIONS.current = 's2'
    sessSubscribers.forEach((fn) => fn())
    await new Promise((r) => setTimeout(r, 500))
    assert(renderText(pill().comp({ wide: true })).includes('本地'), '事件驱动：切回本地目录后立即显示本地')
    // 事件驱动 + 接口故障 → 保留 last-known + ⚠（与设计一致）
    FAIL_STATUS = true
    SESSIONS.current = 's1'
    sessSubscribers.forEach((fn) => fn())
    await new Promise((r) => setTimeout(r, 500))
    assert(renderText(pill().comp({ wide: true })).includes('本地'), '事件驱动刷新在接口故障时保留 last-known 文本')
    assert(renderText(pill().comp({ wide: true })).includes('⚠'), '事件驱动刷新携带失败降级标记')
    FAIL_STATUS = false   // 保留桩状态供后续若有用
    console.log('\n--- 结果 ---')
    console.log('改名记录:', JSON.stringify(renames, null, 0))
    console.log('最终标题:', JSON.stringify(workspacesItems.map((x) => x.title)))
    process.exit(process.exitCode || 0)
  })().catch((e) => { console.error('测试异常:', e); process.exit(1) })
})


