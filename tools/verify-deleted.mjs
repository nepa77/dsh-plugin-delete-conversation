#!/usr/bin/env node
/**
 * Check that a deleted conversation really left nothing behind.
 *
 * DSH has no delete API and the sidebar never shows a session id, so proving a
 * delete means comparing three artifacts before and after:
 *
 *   1. <dshHome>/sessions/<project>/<sessionId>/          the durable event log
 *   2. <dshHome>/storages/session_projcache/sessions/<sessionId>.json
 *                                                         the projection cache
 *   3. <dshHome>/storages/workspace.json                  workspace membership,
 *      archivedSessionIds and pinnedSessionIds
 *
 * Recommended workflow (needs no id in advance):
 *
 *   node tools/verify-deleted.mjs --snapshot before.json     # before deleting
 *   ... click Delete session twice in the GUI ...
 *   node tools/verify-deleted.mjs --diff before.json         # shows what vanished
 *
 * Direct checks:
 *
 *   node tools/verify-deleted.mjs --list                     # id -> title table
 *   node tools/verify-deleted.mjs --title 一次性              # find by title
 *   node tools/verify-deleted.mjs --id session-0123…         # check one exact id
 *
 * Tips: `chcp 65001` first if Chinese titles look garbled; set DSH_HOME to point
 * this at another installation. Read-only except for --snapshot.
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const option = (name) => {
  const at = argv.indexOf(name)
  if (at === -1) return undefined
  const next = argv[at + 1]
  return next === undefined || next.startsWith('--') ? true : next
}

const dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const sessionsRoot = path.join(dshHome, 'sessions')
const cacheRoot = path.join(dshHome, 'storages', 'session_projcache', 'sessions')
const workspaceFile = path.join(dshHome, 'storages', 'workspace.json')

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8').catch(() => 'null'))

const clip = (text, max = 48) => {
  if (typeof text !== 'string') return ''
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

/** Title and first prompt live in the projection cache — the only id→name mapping on disk. */
async function readCache(file) {
  const document = await readJson(file)
  const rows = document?.record?.rows ?? {}
  return {
    title: typeof rows.title?.val === 'string' ? rows.title.val : '',
    firstPrompt: clip(rows.titleInput?.val?.first?.text, 60),
    cwd: document?.record?.identity?.cwd,
    createdAt: document?.record?.identity?.createdAt,
  }
}

async function inventory() {
  const sessions = []
  for (const project of await readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!project.isDirectory()) continue
    for (const entry of await readdir(path.join(sessionsRoot, project.name), { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue
      const dir = path.join(sessionsRoot, project.name, entry.name)
      let logBytes = 0
      for (const file of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!file.isFile()) continue
        logBytes += (await stat(path.join(dir, file.name)).catch(() => ({ size: 0 }))).size
      }
      const cacheFile = path.join(cacheRoot, `${entry.name}.json`)
      const cacheExists = (await stat(cacheFile).catch(() => undefined)) !== undefined
      sessions.push({
        sessionId: entry.name,
        project: project.name,
        dir,
        logBytes,
        cacheFile,
        cacheExists,
        ...(cacheExists ? await readCache(cacheFile) : {}),
      })
    }
  }

  // A session can also survive only as a cache file or only as a membership id.
  const cachedOnly = []
  for (const file of await readdir(cacheRoot, { withFileTypes: true }).catch(() => [])) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue
    const id = file.name.slice(0, -'.json'.length)
    if (!sessions.some((session) => session.sessionId === id)) {
      cachedOnly.push({ sessionId: id, cacheFile: path.join(cacheRoot, file.name), ...(await readCache(path.join(cacheRoot, file.name))) })
    }
  }

  const workspace = await readJson(workspaceFile)
  const records = {}
  for (const [id, record] of Object.entries(workspace?.tables?.workspaces ?? {})) {
    records[id] = { title: record.title, path: record.path, sessionIds: record.sessionIds ?? [] }
  }
  return {
    capturedAt: new Date().toISOString(),
    dshHome,
    sessions: sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    cachedOnly,
    workspace: {
      records,
      archivedSessionIds: workspace?.global?.archivedSessionIds ?? [],
      pinnedSessionIds: workspace?.global?.pinnedSessionIds ?? [],
    },
  }
}

const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`)

function reportSession(session, workspace, prefix) {
  const memberships = []
  for (const [id, record] of Object.entries(workspace.records)) {
    if (record.sessionIds.includes(session.sessionId)) memberships.push(`${record.title ?? id} (${id})`)
  }
  if (workspace.archivedSessionIds.includes(session.sessionId)) memberships.push('archivedSessionIds')
  if (workspace.pinnedSessionIds.includes(session.sessionId)) memberships.push('pinnedSessionIds')
  console.log(`${prefix}${session.sessionId}`)
  line('title', session.title || '(no cache document)')
  line('first prompt', session.firstPrompt || '-')
  line('log dir', `${session.dir}  [${session.logBytes} bytes]`)
  line('cache file', `${session.cacheFile}  [${session.cacheExists ? 'present' : 'absent'}]`)
  line('workspace refs', memberships.length === 0 ? 'none' : memberships.join(', '))
}

function verdict(session, workspace) {
  const dirExists = session.logBytes > 0 || session.dirExists === true
  const referenced = Object.values(workspace.records).some((record) => record.sessionIds.includes(session.sessionId))
  const archived = workspace.archivedSessionIds.includes(session.sessionId)
  const pinned = workspace.pinnedSessionIds.includes(session.sessionId)
  const leftovers = []
  if (dirExists) leftovers.push('log dir')
  if (session.cacheExists) leftovers.push('cache file')
  if (referenced) leftovers.push('workspace sessionIds')
  if (archived) leftovers.push('archivedSessionIds')
  if (pinned) leftovers.push('pinnedSessionIds')
  console.log(
    leftovers.length === 0
      ? '  => FULLY DELETED: no log dir, no cache file, no workspace reference\n'
      : `  => STILL PRESENT: ${leftovers.join(', ')}\n`,
  )
}

const snapshotPath = option('--snapshot')
const diffPath = option('--diff')
const wantedId = option('--id')
const wantedTitle = option('--title')
const list = option('--list') === true || (!snapshotPath && !diffPath && !wantedId && !wantedTitle)

const current = await inventory()

if (snapshotPath) {
  await writeFile(snapshotPath, JSON.stringify(current, null, 2), 'utf8')
  console.log(`snapshot written: ${snapshotPath}`)
  console.log(`  sessions: ${current.sessions.length}, cache-only: ${current.cachedOnly.length}`)
  console.log('delete the conversation in the GUI, then run: node tools/verify-deleted.mjs --diff ' + snapshotPath)
} else if (diffPath) {
  const before = JSON.parse(await readFile(diffPath, 'utf8'))
  const nowIds = new Set(current.sessions.map((session) => session.sessionId))
  const gone = before.sessions.filter((session) => !nowIds.has(session.sessionId))
  const still = before.sessions.filter((session) => nowIds.has(session.sessionId))
  console.log(`snapshot: ${before.capturedAt}  (${before.sessions.length} sessions)`)
  console.log(`now:      ${current.capturedAt}  (${current.sessions.length} sessions)\n`)
  if (gone.length === 0) {
    console.log('NO SESSION DISAPPEARED since the snapshot — nothing was deleted.\n')
  } else {
    console.log(`DISAPPEARED (${gone.length}):`)
    for (const session of gone) {
      const cacheStill = (await stat(session.cacheFile).catch(() => undefined)) !== undefined
      const dirStill = (await stat(session.dir).catch(() => undefined)) !== undefined
      const referenced = Object.values(current.workspace.records).some((record) => record.sessionIds.includes(session.sessionId))
      reportSession({ ...session, cacheExists: cacheStill, logBytes: dirStill ? session.logBytes : 0, dirExists: dirStill }, current.workspace, '  - ')
      const leftovers = []
      if (dirStill) leftovers.push('log dir')
      if (cacheStill) leftovers.push('cache file')
      if (referenced) leftovers.push('workspace sessionIds')
      if (current.workspace.archivedSessionIds.includes(session.sessionId)) leftovers.push('archivedSessionIds')
      if (current.workspace.pinnedSessionIds.includes(session.sessionId)) leftovers.push('pinnedSessionIds')
      console.log(
        leftovers.length === 0
          ? '  => FULLY DELETED: log dir, cache file and every workspace reference are gone\n'
          : `  => STILL PRESENT: ${leftovers.join(', ')}\n`,
      )
    }
  }
  console.log(`still present: ${still.length} session(s)`)
} else if (wantedId || wantedTitle) {
  const needle = String(wantedTitle ?? '').toLowerCase()
  const matches = current.sessions.filter((session) => {
    if (wantedId) {
      const id = String(wantedId)
      return session.sessionId === id || session.sessionId === `session-${id}` || session.sessionId.startsWith(id)
    }
    return session.title.toLowerCase().includes(needle) || session.firstPrompt.toLowerCase().includes(needle)
  })
  if (matches.length === 0) {
    console.log('No session in the current log directory matches.')
    console.log('That is what a completed delete looks like - but a never-existent id looks the same,')
    console.log('so use --snapshot/--diff when you need proof of what was there before.')
  } else {
    for (const session of matches) {
      reportSession(session, current.workspace, '- ')
      verdict(session, current.workspace)
    }
  }
  const cacheOnly = current.cachedOnly.filter(
    (session) => (wantedId && session.sessionId.includes(String(wantedId))) || (wantedTitle && session.title.toLowerCase().includes(needle)),
  )
  if (cacheOnly.length > 0) {
    console.log('Leftover cache documents with no log directory (a partly finished delete):')
    for (const session of cacheOnly) console.log(`  - ${session.sessionId}  ${session.cacheFile}`)
  }
} else if (list) {
  console.log(`dshHome: ${dshHome}`)
  console.log(`sessions: ${current.sessions.length}, cache-only leftovers: ${current.cachedOnly.length}\n`)
  console.log('  sessionId                                        cache  bytes      title / first prompt')
  for (const session of current.sessions) {
    console.log(
      `  ${session.sessionId.padEnd(48)} ${(session.cacheExists ? 'yes' : 'NO ').padEnd(6)} ${String(session.logBytes).padStart(8)}  ${clip(session.title, 28)} ${clip(session.firstPrompt, 30)}`,
    )
  }
  console.log('\nworkspace membership:')
  for (const [id, record] of Object.entries(current.workspace.records)) {
    console.log(`  ${record.title ?? id}  sessions=${record.sessionIds.length}  archived=${current.workspace.archivedSessionIds.length} pinned=${current.workspace.pinnedSessionIds.length}`)
  }
  if (current.cachedOnly.length > 0) {
    console.log('\ncache documents with no log directory:')
    for (const session of current.cachedOnly) console.log(`  ${session.sessionId}  ${clip(session.title, 40)}`)
  }
}
