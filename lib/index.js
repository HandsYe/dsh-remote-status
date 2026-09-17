// dsh-remote-status — host side.
//
// Reads the dsh-remote data sources this plugin builds on:
//   • $DSH_HOME/remote-workspaces/machines.json          (machine registry)
//   • $DSH_HOME/remote-workspaces/<host-dir>/<name>/.dsh-remote-meta.json  (mirror map)
// and serves three small JSON routes:
//   GET /dsh-remote-status/status?sessionId=<id>         session remote/local + current machine
//   GET /dsh-remote-status/machines                      machine registry
//   GET /dsh-remote-status/resolve-mirror?local=<path>   mirror lookup for a local path
//
// No tools are registered on purpose: the plugin is a pure UI indicator and
// must never conflict with other rw_* providers.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { registerHttpTransports } from './http-transport.js'

export const name = 'dsh-remote-status'
export const inject = []

function dshBase() {
  const env = process.env.DSH_HOME
  if (env && String(env).trim()) return path.resolve(String(env).trim())
  return path.join(os.homedir(), '.dsh')
}

const root = () => path.join(dshBase(), 'remote-workspaces')

/** Machine registry: { machines: [{id,name,host,port,username,workspace}], currentId } */
function readMachines() {
  try {
    const raw = JSON.parse(readFileSync(path.join(root(), 'machines.json'), 'utf8'))
    const list = Array.isArray(raw.list)
      ? raw.list
          .map((m) => m && m.id ? {
            id: m.id,
            name: m.name,
            host: m.host,
            port: m.port,
            username: m.username,
            workspace: m.workspace,
          } : null)
          .filter(Boolean)
      : []
    return { machines: list, currentId: raw.currentId || null }
  } catch (error) {
    return { machines: [], currentId: null }
  }
}

/** Find the mirror whose local directory contains `local`; returns mirrorDir + remotePath. */
function resolveMirror(local) {
  const base = path.resolve(String(local || '')).replace(/[\\/]+$/, '') || ''
  const r = root()
  try {
    if (!existsSync(r) || !base) return null
    for (const hostDir of readdirSync(r)) {
      const hostPath = path.join(r, hostDir)
      if (!statSync(hostPath, { throwIfNoEntry: false })?.isDirectory?.()) continue
      for (const name of readdirSync(hostPath)) {
        const metaPath = path.join(hostPath, name, '.dsh-remote-meta.json')
        if (!existsSync(metaPath)) continue
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
          const mirrorAbs = path.resolve(path.join(hostPath, name))
          if (mirrorAbs === base || base.startsWith(mirrorAbs + path.sep)) {
            return { mirrorDir: mirrorAbs, remotePath: String(meta.remotePath || ''), hostDir }
          }
        } catch (error) { /* skip unparsable meta */ }
      }
    }
  } catch (error) { /* scan failed */ }
  return null
}

function sessionCwdOf(ctx, sessionId) {
  try {
    const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : null
    const header = session && session.header ? session.header : null
    if (header && header.cwd) return String(header.cwd)
  } catch (error) { /* sessions service unavailable */ }
  return ''
}

/** Match a machine registry entry by mirror hostDir (e.g. "172.16.233.225-yehui-22"). */
function machineOfHostDir(machines, hostDir) {
  if (!machines || !hostDir) return null
  const h = String(hostDir)
  for (const m of machines) {
    const host = String(m.host || '')
    if (!host) continue
    if (h === host || h.startsWith(host + '-')) return m
  }
  return null
}

const sendJson = (res, code, obj) => {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

const exact = (path, handler) => ({ kind: 'exact', path, handler })

function buildRoutes(ctx) {
  const statusOf = (sessionId) => {
    const registry = readMachines()
    const cwd = sessionId ? sessionCwdOf(ctx, sessionId) : ''
    const hit = cwd ? resolveMirror(cwd) : null
    const sessionMachine = hit ? machineOfHostDir(registry.machines, hit.hostDir) : null
    return {
      ok: true,
      currentId: registry.currentId,
      machines: registry.machines,
      sessionMode: hit ? 'remote' : 'local',
      sessionRemotePath: hit ? hit.remotePath : '',
      sessionMachineId: sessionMachine ? sessionMachine.id : null,
      sessionMachineName: sessionMachine ? (sessionMachine.name || sessionMachine.host || '') : '',
      sessionHostDir: hit ? hit.hostDir : '',
      sessionId: sessionId || '',
    }
  }
  return [
    exact('/dsh-remote-status/status', async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const q = new URL(req.url, 'http://localhost').searchParams
        const sessionId = q.get('sessionId') ? decodeURIComponent(q.get('sessionId')) : ''
        sendJson(res, 200, statusOf(sessionId))
      } catch (error) {
        sendJson(res, 500, { error: String((error && error.message) || error) })
      }
    }),
    exact('/dsh-remote-status/machines', async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      sendJson(res, 200, readMachines())
    }),
    exact('/dsh-remote-status/resolve-mirror', async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const q = new URL(req.url, 'http://localhost').searchParams
        const local = q.get('local') ? decodeURIComponent(q.get('local')) : ''
        const hit = local ? resolveMirror(local) : null
        sendJson(res, 200, hit
          ? { local, remotePath: hit.remotePath, mirrorDir: hit.mirrorDir, mode: 'remote', fallback: false }
          : { local, remotePath: '', mirrorDir: null, mode: 'local', fallback: true })
      } catch (error) {
        sendJson(res, 500, { error: String((error && error.message) || error) })
      }
    }),
  ]
}

export async function apply(ctx) {
  registerHttpTransports(ctx, buildRoutes(ctx))
}