// Verify the host route recovers cwd from the durable zstd session header
// when the live sessions service has no header.cwd (e.g. newer DSH sessions).
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const { pathToFileURL } = require('node:url')

async function main() {
  assert.equal(typeof zlib.zstdCompressSync, 'function', 'Node must support zstd for this test')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-status-host-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = temp
  try {
    const remoteRoot = path.join(temp, 'remote-workspaces')
    const hostDir = '10.22.33.44-dev-22'
    const mirrorDir = path.join(remoteRoot, hostDir, 'api')
    fs.mkdirSync(mirrorDir, { recursive: true })
    fs.writeFileSync(path.join(mirrorDir, '.dsh-remote-meta.json'), JSON.stringify({
      host: '10.22.33.44', port: 22, username: 'dev', remotePath: '/srv/api',
    }))
    fs.writeFileSync(path.join(remoteRoot, 'machines.json'), JSON.stringify({
      currentId: 'other-machine',
      list: [
        { id: 'api-machine', name: 'API 服务器', host: '10.22.33.44', port: 22, username: 'dev' },
        { id: 'other-machine', name: '当前连接服务器', host: '192.0.2.1', port: 22, username: 'ops' },
      ],
    }))

    const sessionId = 'session-fallback-test'
    const sessionDir = path.join(temp, 'sessions', 'project-key', sessionId)
    fs.mkdirSync(sessionDir, { recursive: true })
    const header = Buffer.from(JSON.stringify({ cwd: mirrorDir }) + '\n' + JSON.stringify({ type: 'message' }) + '\n')
    fs.writeFileSync(path.join(sessionDir, 'session.jsonl.zstd'), zlib.zstdCompressSync(header))

    // Deliberately provide no cwd/header in memory; lookup must use the zstd log.
    const sessions = { get: (id) => id === sessionId ? { id } : null }
    const routes = new Map()
    const webServer = { register(route) { routes.set(route.path, route); return () => {} } }
    const connection = { fetch: { register() { return () => {} } } }
    const ctx = {
      get(name) { return name === 'sessions' ? sessions : null },
      inject(names, callback) {
        const inner = {
          get(name) { return name === 'webServer' ? webServer : name === 'connection' ? connection : null },
          effect() { return () => {} },
        }
        callback(inner)
      },
    }

    const { apply } = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href)
    await apply(ctx)
    const route = routes.get('/dsh-remote-status/status')
    assert.ok(route, 'status route registered')

    let body = ''
    const res = {
      statusCode: 200,
      setHeader() {},
      end(value) { body = String(value) },
    }
    await route.handler({ method: 'GET', url: `/dsh-remote-status/status?sessionId=${sessionId}` }, res)
    const status = JSON.parse(body)
    assert.equal(status.sessionMode, 'remote')
    assert.equal(status.sessionRemotePath, '/srv/api')
    assert.equal(status.sessionMachineName, 'API 服务器')
    assert.equal(status.currentId, 'other-machine', 'global current machine must not override session machine')
    console.log('✓ missing in-memory cwd recovered from zstd session header')
    console.log('✓ session mirror and session machine resolve independently of global currentId')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
