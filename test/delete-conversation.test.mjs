/**
 * Dependency-free checks for the Host half's delete algorithm.
 *
 * These run the real `deleteConversation()` from `src/index.js` against a fake DSH
 * composition (in-memory domains + registry) and a throwaway `<dshHome>` tree, so
 * they verify the ordering guarantees and the fail-closed paths without touching
 * a live profile.
 *
 * Run:  node test/delete-conversation.test.mjs
 *
 * Keep this file green when adapting the plugin: it is the cheapest proof that a
 * patched seam still produces "all of it, or nothing".
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const fsp = require('node:fs/promises')
const plugin = require('../src/index.js')

const SESSION_ID = 'session-11111111-2222-3333-4444-555555555555'
const OTHER_ID = 'session-99999999-8888-7777-6666-555555555555'
const WORKSPACE_ID = 'w-0001'

let checks = 0
function ok(label) {
  checks += 1
  process.stdout.write(`  ok  ${label}\n`)
}

/** A throwaway dshHome with one real session-log directory. */
async function makeHome(sessionId = SESSION_ID) {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-delete-test-'))
  const sessionsRoot = path.join(home, 'sessions')
  const logDir = path.join(sessionsRoot, '--D-work--', sessionId)
  await mkdir(logDir, { recursive: true })
  await writeFile(path.join(logDir, 'session.v4.jsonl.zstd'), 'fake-log')
  const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(path.join(cacheDir, `${sessionId}.json`), '{"identity":{}}')
  return { home, sessionsRoot, logDir }
}

/**
 * A fake Host context with the exact seams the plugin reads, all mutable so the
 * test can assert what the algorithm did.
 */
function makeHost({ home, sessionsRoot, names = ['storageDomain', 'workspaceRegistry', 'sessions', 'agents', 'sessionPersistence', 'webServer', 'skills'] }) {
  const state = {
    records: new Map([
      [WORKSPACE_ID, { path: 'D:\\work', title: 'work', sessionIds: [SESSION_ID, OTHER_ID], createdAt: 'a', updatedAt: 'b' }],
    ]),
    globalValue: {
      initialized: true,
      defaultWorkspaceId: WORKSPACE_ID,
      workspaceIds: [WORKSPACE_ID],
      archivedSessionIds: [SESSION_ID],
      pinnedSessionIds: [SESSION_ID],
    },
    cacheDeletes: [],
    detached: [],
    archiveCalls: [],
    events: [],
    live: false,
    running: false,
  }

  const workspacesTable = {
    get: (key) => state.records.get(key),
    entries: () => state.records.entries(),
    put: async (key, value) => {
      state.records.set(key, value)
    },
    delete: async (key) => state.records.delete(key),
  }
  const workspaceDomain = {
    name: 'workspace',
    global: { get: () => state.globalValue, set: async (value) => { state.globalValue = value } },
    table: (name) => (name === 'workspaces' ? workspacesTable : undefined),
    close: async () => {},
  }
  const projcacheDomain = {
    name: 'session_projcache',
    table: (name) =>
      name === 'sessions'
        ? {
            delete: async (key) => {
              state.cacheDeletes.push(key)
              return true
            },
          }
        : undefined,
  }
  const registry = {
    async archiveSession(id, options) {
      state.archiveCalls.push([id, options])
      state.globalValue = {
        ...state.globalValue,
        archivedSessionIds: state.globalValue.archivedSessionIds.includes(id)
          ? state.globalValue.archivedSessionIds
          : [...state.globalValue.archivedSessionIds, id],
        pinnedSessionIds: state.globalValue.pinnedSessionIds.filter((entry) => entry !== id),
      }
      // Simulate the shipped `workspace/session-stop` listener cancelling the turn.
      state.running = false
    },
    async unarchiveSession(id) {
      state.globalValue = {
        ...state.globalValue,
        archivedSessionIds: state.globalValue.archivedSessionIds.filter((entry) => entry !== id),
      }
    },
    async unpinSession(id) {
      state.globalValue = {
        ...state.globalValue,
        pinnedSessionIds: state.globalValue.pinnedSessionIds.filter((entry) => entry !== id),
      }
    },
    list() {
      return [
        {
          id: WORKSPACE_ID,
          async detachSession(id) {
            state.detached.push(id)
            const record = state.records.get(WORKSPACE_ID)
            if (record !== undefined) {
              state.records.set(WORKSPACE_ID, {
                ...record,
                sessionIds: record.sessionIds.filter((entry) => entry !== id),
              })
            }
          },
        },
      ]
    },
  }

  const available = {
    storageDomain: { get: (name) => (name === 'workspace' ? workspaceDomain : name === 'session_projcache' ? projcacheDomain : undefined) },
    workspaceRegistry: registry,
    sessions: { get: (id) => (state.live && id === SESSION_ID ? { id } : undefined) },
    agents: { get: (id) => (id === SESSION_ID && state.running ? { status: 'running' } : undefined) },
    sessionPersistence: { stat: async () => undefined },
    webServer: { register: () => () => {} },
    skills: { register: () => () => {} },
  }

  const ctx = {
    config: {},
    logger: { info() {}, warn() {} },
    get: (name) => (names.includes(name) ? available[name] : undefined),
    effect: (callback) => callback(),
    emit: (event, payload) => {
      state.events.push([event, payload])
    },
  }

  return { ctx, state, workspaceDomain }
}

const fakeState = (fixture) => ({
  dshHome: fixture.home,
  sessionsRoots: [fixture.sessionsRoot],
  layoutVerified: false,
  routesRegistered: false,
  version: 'test',
  adaptedFor: 'test',
})

async function exists(target) {
  return (await stat(target).catch(() => undefined)) !== undefined
}

/* ------------------------------------------------------------------ */

process.stdout.write('cold session: everything is removed, in order\n')
{
  const fixture = await makeHome()
  const { ctx, state } = makeHost(fixture)
  const hostState = fakeState(fixture)
  const result = await plugin.deleteConversation(ctx, hostState, SESSION_ID)

  assert.equal(result.ok, true)
  assert.deepEqual(result.warnings, [], `unexpected warnings: ${JSON.stringify(result.warnings)}`)
  assert.equal(await exists(fixture.logDir), false, 'log directory must be gone')
  assert.deepEqual(state.cacheDeletes, [SESSION_ID], 'projection cache record must be deleted through the domain')
  assert.deepEqual(state.detached, [SESSION_ID], 'Workspace.detachSession must be used')
  assert.deepEqual(state.records.get(WORKSPACE_ID).sessionIds, [OTHER_ID], 'only the deleted id leaves sessionIds')
  assert.deepEqual(state.globalValue.archivedSessionIds, [], 'archive gate must be cleared last')
  assert.deepEqual(state.globalValue.pinnedSessionIds, [], 'pin membership must be cleared last')
  assert.equal(result.removed.projectionCacheEntry, true)
  assert.deepEqual(
    result.removed.domainGlobalFields,
    ['archivedSessionIds', 'pinnedSessionIds'],
    'the report names the membership that actually changed',
  )
  assert.equal(hostState.layoutVerified, true, 'locating a real directory marks the layout verified')
  assert.deepEqual(state.events, [['api-session/removed', SESSION_ID]], 'the browser must be told the session is gone')
  assert.equal(result.removed.notified, true)
  assert.equal(result.removed.stillInMemory, false, 'a cold session leaves nothing in memory')
  await rm(fixture.home, { recursive: true, force: true })
  ok('deleted log + cache + membership, warnings empty, browser notified')
}

process.stdout.write('unknown session id: deletes nothing and reports no membership change\n')
{
  const fixture = await makeHome()
  const { ctx, state } = makeHost(fixture)
  const result = await plugin.deleteConversation(ctx, fakeState(fixture), 'session-00000000-0000-4000-8000-000000000000')

  assert.equal(result.ok, true)
  assert.deepEqual(result.removed.logDirectories, [])
  assert.deepEqual(result.removed.detachedFromWorkspaces, [], 'no workspace held that id')
  assert.deepEqual(result.removed.domainGlobalFields, [], 'neither archive nor pin set held that id')
  assert.equal(result.warnings.length, 1, 'the missing log directory is reported')
  assert.deepEqual(state.records.get(WORKSPACE_ID).sessionIds, [SESSION_ID, OTHER_ID], 'real membership untouched')
  assert.equal(await exists(fixture.logDir), true, 'the real log is untouched')
  await rm(fixture.home, { recursive: true, force: true })
  ok('fabricated id: no membership reported, nothing removed')
}

process.stdout.write('live session: stop first, then delete\n')
{
  const fixture = await makeHome()
  const { ctx, state } = makeHost(fixture)
  state.live = true
  state.running = true
  const result = await plugin.deleteConversation(ctx, fakeState(fixture), SESSION_ID)

  assert.deepEqual(
    state.archiveCalls.map(([id, options]) => [id, options.stopActivity]),
    [[SESSION_ID, true]],
    'the shipped stop path must run with stopActivity',
  )
  assert.equal(result.removed.stoppedActivity, true)
  assert.equal(await exists(fixture.logDir), false)
  // The session is still in the in-memory store, which is the one leftover a plugin
  // cannot clean; the report must say so instead of claiming a clean removal.
  assert.equal(result.removed.stillInMemory, true)
  assert.ok(
    result.warnings.some((warning) => warning.includes('restart DSH')),
    `the live-session leftover must be reported: ${JSON.stringify(result.warnings)}`,
  )
  await rm(fixture.home, { recursive: true, force: true })
  ok('archiveSession(id, {stopActivity:true}) ran before the removal; the in-memory leftover is reported')
}

process.stdout.write('running session that refuses to stop: nothing is deleted\n')
{
  const fixture = await makeHome()
  const { ctx, state } = makeHost(fixture)
  state.live = true
  state.running = true
  // The stop never lands: keep reporting "running" no matter what.
  const realGet = ctx.get
  ctx.get = (name) =>
    name === 'agents'
      ? { get: (id) => (id === SESSION_ID ? { status: 'running' } : undefined) }
      : realGet(name)

  await assert.rejects(
    () => plugin.deleteConversation(ctx, fakeState(fixture), SESSION_ID),
    (error) => error.code === 'session-still-running',
  )
  assert.equal(await exists(fixture.logDir), true, 'log must survive a refused delete')
  assert.deepEqual(state.detached, [], 'membership must not change')
  await rm(fixture.home, { recursive: true, force: true })
  ok('session-still-running, log and membership untouched')
}

process.stdout.write('log removal failure: abort before touching membership\n')
{
  const fixture = await makeHome()
  const { ctx, state } = makeHost(fixture)
  const originalRm = fsp.rm
  fsp.rm = async () => {
    const error = new Error('EBUSY: simulated open handle')
    error.code = 'EBUSY'
    throw error
  }
  let failure
  try {
    await plugin.deleteConversation(ctx, fakeState(fixture), SESSION_ID)
  } catch (error) {
    failure = error
  } finally {
    fsp.rm = originalRm
  }
  assert.equal(failure?.code, 'log-removal-failed')
  assert.deepEqual(state.detached, [], 'membership must be left alone when the log survives')
  assert.deepEqual(state.cacheDeletes, [], 'the cache must not be pruned either')
  assert.deepEqual(state.records.get(WORKSPACE_ID).sessionIds, [SESSION_ID, OTHER_ID])
  assert.equal(await exists(fixture.logDir), true)
  await rm(fixture.home, { recursive: true, force: true })
  ok('log-removal-failed, nothing else changed')
}

process.stdout.write('missing workspace domain: fail closed\n')
{
  const fixture = await makeHome()
  const { ctx } = makeHost({ ...fixture, names: ['workspaceRegistry', 'sessions'] })
  await assert.rejects(
    () => plugin.deleteConversation(ctx, fakeState(fixture), SESSION_ID),
    (error) => error.code === 'workspace-domain-unavailable',
  )
  assert.equal(await exists(fixture.logDir), true)
  await rm(fixture.home, { recursive: true, force: true })
  ok('workspace-domain-unavailable before any write')
}

process.stdout.write('malformed session id: refused\n')
{
  const fixture = await makeHome()
  const { ctx } = makeHost(fixture)
  for (const bad of ['', '..', '../../etc', 'a/b', null, 42]) {
    await assert.rejects(
      () => plugin.deleteConversation(ctx, fakeState(fixture), bad),
      (error) => error.code === 'bad-session-id',
      `id ${String(bad)} must be refused`,
    )
  }
  assert.equal(await exists(fixture.logDir), true)
  await rm(fixture.home, { recursive: true, force: true })
  ok('bad-session-id for traversal-shaped ids')
}

process.stdout.write('fallback: no detachSession, no unarchive/unpin\n')
{
  const fixture = await makeHome()
  const { ctx, state, workspaceDomain } = makeHost(fixture)
  const registry = ctx.get('workspaceRegistry')
  const bare = { archiveSession: registry.archiveSession }
  const realGet = ctx.get
  ctx.get = (name) => (name === 'workspaceRegistry' ? bare : realGet(name))

  const result = await plugin.deleteConversation(ctx, fakeState(fixture), SESSION_ID)

  assert.deepEqual(state.records.get(WORKSPACE_ID).sessionIds, [OTHER_ID], 'the workspaces table carries the fallback')
  assert.deepEqual(workspaceDomain.global.get().archivedSessionIds, [])
  assert.deepEqual(workspaceDomain.global.get().pinnedSessionIds, [])
  assert.equal(result.ok, true)
  await rm(fixture.home, { recursive: true, force: true })
  ok('domain table and domain global carry the fallback')
}

process.stdout.write('cache fallback: unlink the projection file when the domain is absent\n')
{
  const fixture = await makeHome()
  const { ctx } = makeHost({ ...fixture, names: ['storageDomain', 'workspaceRegistry'] })
  // Replace storageDomain with one that has no session_projcache domain at all.
  const realGet = ctx.get
  const original = realGet('storageDomain')
  ctx.get = (name) =>
    name === 'storageDomain' ? { get: (domain) => (domain === 'workspace' ? original.get('workspace') : undefined) } : realGet(name)

  const result = await plugin.deleteConversation(ctx, fakeState(fixture), SESSION_ID)
  assert.equal(result.removed.projectionCacheEntry, true)
  assert.equal(
    await exists(path.join(fixture.home, 'storages', 'session_projcache', 'sessions', `${SESSION_ID}.json`)),
    false,
  )
  await rm(fixture.home, { recursive: true, force: true })
  ok('projection cache file removed on disk')
}

process.stdout.write('doctor report\n')
{
  const fixture = await makeHome()
  const complete = makeHost(fixture)
  const report = await plugin.buildDoctorReport(complete.ctx, fakeState(fixture))
  assert.equal(report.ok, true, `expected a healthy report, got ${JSON.stringify(report.requiredFailures)}`)
  assert.deepEqual(report.requiredFailures, [])
  assert.ok(report.checks.length > 8, 'the report must cover every seam')

  const broken = makeHost({ ...fixture, names: ['sessions'] })
  const brokenReport = await plugin.buildDoctorReport(broken.ctx, fakeState(fixture))
  assert.equal(brokenReport.ok, false)
  assert.ok(brokenReport.requiredFailures.includes('workspaceRegistry.archiveSession'))
  assert.ok(brokenReport.requiredFailures.includes('webServer.register'))
  await rm(fixture.home, { recursive: true, force: true })
  ok('healthy report passes; a missing seam is named')
}

process.stdout.write('shipped SKILL.md is present and parseable as frontmatter + body\n')
{
  const skillPath = path.join(import.meta.dirname, '..', 'skill', 'dsh-plugin-delete-conversation', 'SKILL.md')
  const markdown = await readFile(skillPath, 'utf8')
  assert.match(markdown, /^---\nname: dsh-plugin-delete-conversation\n/)
  assert.ok(markdown.length > 2000, 'the runbook must actually describe the seams')
  ok('skill file present')
}

process.stdout.write(`\n${checks} checks passed\n`)
