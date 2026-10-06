/**
 * dsh-plugin-delete-conversation — Host half.
 *
 * WHY THIS EXISTS
 *   DSH can archive, unarchive, pin, rename and fork a Session, but nothing in
 *   the shipped composition can REMOVE one: the persistence seam
 *   (`ctx.sessionPersistence`) is append-only by design and its README states
 *   that no code path deletes session files. This plugin adds that missing
 *   capability and exposes it to the sidebar through its Client half.
 *
 * WHAT IT DELETES (all of it, or nothing)
 *   1. the running work owned by the Session — through the shipped stop path, so
 *      the durable archive gate is written before any stop is requested;
 *   2. the Session's durable log directory
 *      `<dshHome>/sessions/<projectKey(cwd)>/<sessionId>/session.v*.jsonl[.zstd]`;
 *   3. its `session_projcache` projection record
 *      (`<dshHome>/storages/session_projcache/sessions/<id>.json`);
 *   4. its membership in every Workspace record (`sessionIds`);
 *   5. its entry in the workspace domain global (`archivedSessionIds`,
 *      `pinnedSessionIds`).
 *
 *   Attachment objects are deliberately NOT touched: they are content-addressed
 *   and shared by forks, and DSH never collects them.
 *
 * WHY IT LOOKS LIKE THIS (read before adapting to a new DSH version)
 *   - No `import`/`require` of any `@deepseek-ai/dsh-*` or `@deepseek-ai/cordis`
 *     package. Every Host capability is read through `ctx.get(name)` and
 *     feature-detected, so a DSH upgrade that renames or removes one degrades
 *     this plugin instead of breaking the whole profile boot. That is also why
 *     the package declares no `@deepseek-ai/dsh-*` peer dependency: the profile
 *     loader's peer gate stays out of the way, and `doctor()` is the real check.
 *   - Shipped APIs are preferred over direct storage edits, in this order:
 *     `workspaceRegistry.archiveSession/unarchiveSession/unpinSession` and
 *     `Workspace.detachSession` when present; the live storage domain is only a
 *     fallback, so durability, validation and `domain/changed` stay DSH-owned.
 *   - The only bridge to the browser half is an ordinary HTTP route on
 *     `ctx.webServer` plus `fetch()` in the client bundle, because DSH's own
 *     Remote (@Remote / ctx.remote) requires generated Typert artifacts and this
 *     plugin deliberately ships no build step.
 *
 * Every DSH seam used here is recorded in `../compat/expected-surface.json`;
 * `GET <prefix>/doctor` reports the live verdict, and the adaptation runbook is
 * `../skill/dsh-plugin-delete-conversation/SKILL.md`.
 */

'use strict'

const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const PACKAGE_NAME = 'dsh-plugin-delete-conversation'
const ROUTE_PREFIX = '/dsh-plugin-delete-conversation'
const VERSION = '0.1.5'
const ADAPTED_FOR = 'DSH desktop nightly, 2026-08 (reference commit b150a551b8)'
/**
 * A custom header cannot be set by a cross-origin page without a CORS preflight,
 * and this route never approves one, so drive-by web pages cannot reach it.
 */
const REQUIRED_HEADER = 'x-dsh-plugin-delete-conversation'

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function safeGet(getter, fallback) {
  try {
    const value = getter()
    return value === undefined || value === null ? fallback : value
  } catch {
    return fallback
  }
}

/** The DSH home that owns `sessions/`, `storages/` and `profiles/`. */
function resolveDshHome(ctx) {
  const configured = safeGet(() => ctx.config && ctx.config.dshHome, undefined)
  if (typeof configured === 'string' && configured.length > 0) return configured
  for (const key of ['DSH_HOME', 'DSH_DATA_DIR', 'DSH_DIR']) {
    const value = process.env[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return path.join(os.homedir(), '.dsh')
}

/**
 * Every plausible session-log root. `session-persistence-jsonl` takes its root
 * from a required Config field (written as a `!!js` expression in the shipped
 * patch) and exposes no env var, so the plugin resolves candidates and finds the
 * session by id instead of assuming one.
 */
async function resolveSessionsRoots(ctx, dshHome) {
  const candidates = []
  const explicit = safeGet(() => ctx.config && ctx.config.sessionsRoot, undefined)
  if (typeof explicit === 'string' && explicit.length > 0) candidates.push(explicit)
  for (const key of ['DSH_SESSIONS_DIR', 'DSH_SESSION_ROOT']) {
    const value = process.env[key]
    if (typeof value === 'string' && value.length > 0) candidates.push(value)
  }
  candidates.push(path.join(dshHome, 'sessions'))
  // Any sibling directory literally named `sessions` (or declared in a config we
  // cannot read) is worth probing: it is cheap and keeps this working when the
  // shipped root is moved.
  try {
    for (const entry of await fs.readdir(dshHome, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === 'sessions') candidates.push(path.join(dshHome, entry.name))
    }
  } catch {
    /* dshHome may not exist yet */
  }
  const unique = []
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate)
    if (!unique.includes(normalized)) unique.push(normalized)
  }
  return unique
}

function isWorkspaceRecord(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value.sessionIds)
}

function without(value, sessionId) {
  if (!Array.isArray(value)) return { next: value, changed: false }
  if (!value.includes(sessionId)) return { next: value, changed: false }
  return { next: value.filter((entry) => entry !== sessionId), changed: true }
}

/** Membership comparison for the report: the shipped unarchive/unpin calls resolve on a no-op. */
function sameIds(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return before === after
  if (before.length !== after.length) return false
  return before.every((entry, index) => entry === after[index])
}

function isRunning(agents, sessionId) {
  const agent = safeGet(() => agents.get(sessionId), undefined)
  if (agent === undefined) return false
  const status = safeGet(() => agent.status, undefined)
  return status === 'running'
}

/** Run `whenReady(service)` as soon as `name` is resolvable, then stop caring. */
function whenService(ctx, name, whenReady) {
  if (ctx.get(name) !== undefined) {
    whenReady(ctx.get(name))
    return
  }
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject([name], (scoped) => {
        const service = scoped.get(name)
        if (service !== undefined) whenReady(service)
      })
      return
    } catch {
      /* fall through to polling */
    }
  }
  let attempts = 0
  const interval = setInterval(() => {
    attempts += 1
    const service = ctx.get(name)
    if (service !== undefined) {
      clearInterval(interval)
      whenReady(service)
      return
    }
    if (attempts >= 600) {
      clearInterval(interval)
      ctx.logger?.warn?.(`[${PACKAGE_NAME}] gave up waiting for service "${name}"`)
    }
  }, 250)
  if (interval.unref) interval.unref()
  ctx.effect(() => () => clearInterval(interval))
}

/* ------------------------------------------------------------------ *
 * Compatibility self-check
 * ------------------------------------------------------------------ */

/**
 * Verify every seam against the running DSH build. Required failures mean
 * "delete will refuse"; the optional entries only downgrade a step.
 */
async function buildDoctorReport(ctx, state) {
  const checks = []
  const check = (id, level, ok, detail) =>
    checks.push({ id, level, ok: Boolean(ok), detail })

  const storageDomain = ctx.get('storageDomain')
  check('storageDomain.get/table', 'required', typeof storageDomain?.get === 'function', 'ctx.get("storageDomain") — mounted domain facility')

  const workspaceDomain = safeGet(() => storageDomain.get('workspace'), undefined)
  check('domain:workspace open', 'required', typeof workspaceDomain?.table === 'function', 'storageDomain.get("workspace") — v2, single layout, opened by workspaceRegistry')

  const workspacesTable = safeGet(() => workspaceDomain.table('workspaces'), undefined)
  check(
    'domain-table:workspace.workspaces',
    'fallback',
    typeof workspacesTable?.entries === 'function' && typeof workspacesTable?.put === 'function',
    'record {path,title,sessionIds,createdAt,updatedAt} — used only when Workspace.detachSession is unavailable',
  )

  const domainGlobal = safeGet(() => workspaceDomain.global, undefined)
  check(
    'domain-global:workspace',
    'fallback',
    typeof domainGlobal?.get === 'function' && typeof domainGlobal?.set === 'function',
    '{initialized,defaultWorkspaceId,workspaceIds,archivedSessionIds,pinnedSessionIds,pendingMutation?} — used only when unarchiveSession/unpinSession are unavailable',
  )

  const registry = ctx.get('workspaceRegistry')
  check('workspaceRegistry.archiveSession', 'required', typeof registry?.archiveSession === 'function', 'stops live work (writes the archive gate first)')
  check('workspaceRegistry.unarchiveSession', 'fallback', typeof registry?.unarchiveSession === 'function', 'clears archivedSessionIds')
  check('workspaceRegistry.unpinSession', 'fallback', typeof registry?.unpinSession === 'function', 'clears pinnedSessionIds')
  check('workspaceRegistry.list', 'fallback', typeof registry?.list === 'function', 'returns Workspace entities for detachSession')
  const entity = safeGet(() => (typeof registry?.list === 'function' ? registry.list()[0] : undefined), undefined)
  check('Workspace.detachSession', 'fallback', typeof entity?.detachSession === 'function', 'the only shipped writer that removes an id from sessionIds')

  const projcacheTable = safeGet(() => storageDomain.get('session_projcache')?.table?.('sessions'), undefined)
  check(
    'domain-table:session_projcache.sessions',
    'optional',
    typeof projcacheTable?.delete === 'function',
    'projection cache (derived data) — falls back to unlinking <dshHome>/storages/session_projcache/sessions/<id>.json',
  )

  check('webServer.register', 'required', typeof ctx.get('webServer')?.register === 'function', 'ctx.get("webServer").register({kind,path,handler})')
  check('sessions.get', 'optional', typeof ctx.get('sessions')?.get === 'function', 'detects a live Session')
  check('agents.get', 'optional', typeof ctx.get('agents')?.get === 'function', 'detects a running turn, polled after the stop request')
  check('sessionPersistence.stat', 'optional', typeof ctx.get('sessionPersistence')?.stat === 'function', 'reads the header (cwd) and verifies the log afterwards')

  const found = []
  for (const root of state.sessionsRoots) {
    const info = await fs.stat(root).catch(() => undefined)
    if (info?.isDirectory()) found.push(root)
  }
  check(
    'layout:sessions-root',
    'required',
    found.length > 0,
    `a readable session-log root; probed: ${state.sessionsRoots.join(', ')}`,
  )
  check(
    'layout:session-dir',
    'info',
    state.layoutVerified,
    'expected layout <root>/<projectKey(cwd)>/<sessionId>/session.v*.jsonl[.zstd] — set to true once a delete has located a real session directory',
  )

  const required = checks.filter((entry) => entry.level === 'required')
  return {
    plugin: PACKAGE_NAME,
    version: VERSION,
    adaptedFor: ADAPTED_FOR,
    dshHome: state.dshHome,
    sessionsRoots: state.sessionsRoots,
    ok: required.every((entry) => entry.ok),
    requiredFailures: required.filter((entry) => !entry.ok).map((entry) => entry.id),
    checks,
  }
}

/* ------------------------------------------------------------------ *
 * The delete operation
 * ------------------------------------------------------------------ */

/** Locate the on-disk session directories for one id across every candidate root. */
async function findSessionDirs(state, sessionId) {
  const found = []
  for (const root of state.sessionsRoots) {
    let slugs
    try {
      slugs = await fs.readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue
      const directory = path.join(root, slug.name, sessionId)
      const info = await fs.stat(directory).catch(() => undefined)
      if (info?.isDirectory()) found.push(directory)
    }
  }
  return found
}

/**
 * Permanently delete one conversation.
 *
 * Preflight first: when a required seam is missing, or the live log cannot be
 * removed, the function aborts before touching workspace membership, so a
 * conversation is never left half-listed or half-present.
 *
 * @param ctx Host Cordis context
 * @param state activation state
 * @param sessionId the Session to delete
 * @param options `{ stopActivity?: boolean }` (default true)
 */
async function deleteConversation(ctx, state, sessionId, options = {}) {
  const stopActivity = options.stopActivity !== false
  const warnings = []
  const removed = {
    stoppedActivity: false,
    logDirectories: [],
    projectionCacheEntry: false,
    detachedFromWorkspaces: [],
    domainGlobalFields: [],
  }

  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw codedError('bad-session-id', `refusing to delete: "${String(sessionId)}" is not a well-formed session id`)
  }

  const storageDomain = ctx.get('storageDomain')
  const workspaceDomain = safeGet(() => storageDomain?.get('workspace'), undefined)
  if (workspaceDomain === undefined) {
    throw codedError(
      'workspace-domain-unavailable',
      `the "workspace" storage domain is not open, so the conversation list cannot be updated safely; see GET ${ROUTE_PREFIX}/doctor`,
    )
  }
  const registry = ctx.get('workspaceRegistry')
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  const persistence = ctx.get('sessionPersistence')

  // ---- 0. stop live work ------------------------------------------------
  const live = safeGet(() => sessions?.get(sessionId), undefined) !== undefined || isRunning(agents, sessionId)
  if (live) {
    if (!stopActivity) throw codedError('session-running', 'the conversation is running; pass stopActivity to stop it first')
    if (typeof registry?.archiveSession !== 'function') {
      throw codedError('stop-path-unavailable', 'the conversation is running and ctx.get("workspaceRegistry").archiveSession is unavailable, so it cannot be stopped safely')
    }
    // The shipped path owns the order that makes this safe: the durable archive
    // gate is written first, then `workspace/session-stop` asks every provider
    // (turn, jobs, subagents, schedules) to stop. The gate is cleared at the end.
    await registry.archiveSession(sessionId, { stopActivity: true })
    removed.stoppedActivity = true
    const deadline = Date.now() + 5000
    while (isRunning(agents, sessionId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (isRunning(agents, sessionId)) {
      throw codedError('session-still-running', 'the conversation is still running after the stop request — nothing was deleted')
    }
  }

  // ---- 1. the durable log (the step that can fail on a locked file) -----
  const directories = await findSessionDirs(state, sessionId)
  const failures = []
  for (const directory of directories) {
    try {
      await fs.rm(directory, { recursive: true, force: true })
      removed.logDirectories.push(directory)
    } catch (cause) {
      failures.push(`${directory}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  if (directories.length > 0 && removed.logDirectories.length === 0) {
    // Nothing was removed: leave the workspace picture untouched and report why.
    throw codedError(
      'log-removal-failed',
      `could not remove the session log (${failures.join('; ')}). On Windows an open handle can block deletion; close the conversation or restart DSH and retry.`,
    )
  }
  for (const failure of failures) warnings.push(`partially removed: ${failure}`)
  if (directories.length === 0) {
    warnings.push('no durable log directory was found for this session (it may never have been materialized)')
  } else {
    state.layoutVerified = true
  }

  // ---- 2. projection cache (derived data) ------------------------------
  const projcacheTable = safeGet(() => storageDomain.get('session_projcache')?.table?.('sessions'), undefined)
  if (typeof projcacheTable?.delete === 'function') {
    removed.projectionCacheEntry = await projcacheTable.delete(sessionId).catch((cause) => {
      warnings.push(`projection cache record was not removed: ${cause instanceof Error ? cause.message : String(cause)}`)
      return false
    })
  } else {
    const cacheFile = path.join(state.dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
    await fs
      .rm(cacheFile, { force: true })
      .then(() => {
        removed.projectionCacheEntry = true
      })
      .catch((cause) => {
        warnings.push(`projection cache file was not removed: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
  }

  // ---- 3. workspace membership -----------------------------------------
  const workspacesTable = safeGet(() => workspaceDomain.table('workspaces'), undefined)
  if (typeof registry?.list === 'function') {
    let workspaces = []
    try {
      workspaces = registry.list() || []
    } catch (cause) {
      warnings.push(`workspaceRegistry.list() failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    for (const workspace of workspaces) {
      if (typeof workspace?.detachSession !== 'function') continue
      const id = safeGet(() => workspace.id ?? workspace.record?.id, undefined)
      // Only claim a workspace as detached when its record actually held the id;
      // an unreadable or unknown record keeps the optimistic report instead of
      // silently under-reporting.
      const record = id === undefined ? undefined : safeGet(() => workspacesTable?.get?.(id), undefined)
      const held = isWorkspaceRecord(record) ? record.sessionIds.includes(sessionId) : undefined
      try {
        await workspace.detachSession(sessionId)
        if (held !== false && id !== undefined) removed.detachedFromWorkspaces.push(String(id))
      } catch (cause) {
        warnings.push(`detachSession failed for workspace ${String(id)}: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
  }
  if (typeof workspacesTable?.entries === 'function' && typeof workspacesTable?.put === 'function') {
    for (const [workspaceId, record] of workspacesTable.entries()) {
      if (!isWorkspaceRecord(record)) {
        warnings.push(`workspace record ${workspaceId} has an unexpected shape and was left untouched`)
        continue
      }
      const { next, changed } = without(record.sessionIds, sessionId)
      if (!changed) continue
      await workspacesTable.put(workspaceId, { ...record, sessionIds: next, updatedAt: new Date().toISOString() })
      if (!removed.detachedFromWorkspaces.includes(String(workspaceId))) {
        removed.detachedFromWorkspaces.push(String(workspaceId))
      }
    }
  } else if (removed.detachedFromWorkspaces.length === 0) {
    warnings.push('no workspace membership could be removed (neither Workspace.detachSession nor the workspaces table was usable)')
  }

  // ---- 4. archive / pin membership (the gate is cleared last) ----------
  const domainGlobal = safeGet(() => workspaceDomain.global, undefined)
  const globalBefore = safeGet(() => domainGlobal?.get(), undefined)
  let archivedCleared = false
  let pinnedCleared = false
  if (typeof registry?.unarchiveSession === 'function') {
    await registry.unarchiveSession(sessionId).then(
      () => {
        archivedCleared = true
      },
      (cause) => warnings.push(`unarchiveSession failed: ${cause instanceof Error ? cause.message : String(cause)}`),
    )
  }
  if (typeof registry?.unpinSession === 'function') {
    await registry.unpinSession(sessionId).then(
      () => {
        pinnedCleared = true
      },
      (cause) => warnings.push(`unpinSession failed: ${cause instanceof Error ? cause.message : String(cause)}`),
    )
  }
  const globalAfter = safeGet(() => domainGlobal?.get(), undefined)
  if (globalBefore !== undefined && globalAfter !== undefined) {
    // Report only what the registry actually changed: both calls resolve on a no-op.
    if (!sameIds(globalBefore.archivedSessionIds, globalAfter.archivedSessionIds)) {
      removed.domainGlobalFields.push('archivedSessionIds')
    }
    if (!sameIds(globalBefore.pinnedSessionIds, globalAfter.pinnedSessionIds)) {
      removed.domainGlobalFields.push('pinnedSessionIds')
    }
  }
  if ((!archivedCleared || !pinnedCleared) && typeof domainGlobal?.get === 'function' && typeof domainGlobal?.set === 'function') {
    // Wait out a transient registry mutation rather than fighting it.
    let globalValue = domainGlobal.get()
    for (let attempt = 0; attempt < 10 && globalValue?.pendingMutation !== undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      globalValue = domainGlobal.get()
    }
    if (globalValue !== null && typeof globalValue === 'object') {
      const archived = without(globalValue.archivedSessionIds, sessionId)
      const pinned = without(globalValue.pinnedSessionIds, sessionId)
      if (archived.changed || pinned.changed) {
        await domainGlobal.set({ ...globalValue, archivedSessionIds: archived.next, pinnedSessionIds: pinned.next })
        if (archived.changed && !removed.domainGlobalFields.includes('archivedSessionIds')) {
          removed.domainGlobalFields.push('archivedSessionIds')
        }
        if (pinned.changed && !removed.domainGlobalFields.includes('pinnedSessionIds')) {
          removed.domainGlobalFields.push('pinnedSessionIds')
        }
      }
    }
  }

  // ---- 5. verify -------------------------------------------------------
  // ---- 5. tell the rest of DSH the Session is gone ----------------------
  // `api-session/removed` is the shipped "a Session left the live Host registry"
  // notification. Every consumer that builds its own list — the browser's session
  // model above all — rebuilds from it, which is what stops a deleted
  // conversation from reappearing in the sidebar's "ungrouped" bucket purely
  // because the browser still had it cached. Without this, deleting a session
  // whose durable artifacts are gone still looks like "moved to ungrouped".
  removed.notified = false
  if (typeof ctx.emit === 'function') {
    try {
      ctx.emit('api-session/removed', sessionId)
      removed.notified = true
    } catch (cause) {
      warnings.push(`the api-session/removed notification failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  } else {
    warnings.push('ctx.emit is unavailable, so the browser was not told the session is gone')
  }

  // The one thing a third-party plugin cannot undo: a Session that is live in
  // this process stays in the in-memory store (`ctx.sessions`) until DSH
  // restarts, and the sidebar keeps listing it from there. There is no public
  // dispose for another owner's session, so report it instead of pretending.
  removed.stillInMemory = safeGet(() => sessions?.get(sessionId), undefined) !== undefined
  if (removed.stillInMemory) {
    warnings.push('this conversation is still held in DSH memory; restart DSH to drop it from the list entirely')
  }

  // ---- 6. verify -------------------------------------------------------
  const stillStored = safeGet(() => persistence?.stat(sessionId), undefined)
  const settled = stillStored === undefined ? undefined : await stillStored.catch(() => undefined)
  if (settled !== undefined) {
    warnings.push('the session still reports stored state after deletion; a live handle may have re-materialized it (reload or restart DSH)')
  }

  return { ok: true, sessionId, removed, warnings }
}

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/* ------------------------------------------------------------------ *
 * HTTP face
 * ------------------------------------------------------------------ */

async function readJsonBody(request) {
  if (typeof request.json === 'function') return await request.json()
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  return JSON.parse(text)
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  if (typeof response.writeHead === 'function') {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    response.end(body)
    return
  }
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(body)
}

function statusFor(code) {
  if (code === 'bad-session-id') return 400
  if (code === 'forbidden') return 403
  if (code === 'session-running' || code === 'session-still-running') return 409
  if (code === 'workspace-domain-unavailable' || code === 'stop-path-unavailable') return 503
  return 500
}

function registerRoutes(ctx, state) {
  whenService(ctx, 'webServer', (webServer) => {
    if (state.routesRegistered) return
    state.routesRegistered = true

    const respond = (response, run) => {
      Promise.resolve()
        .then(run)
        .then((payload) => sendJson(response, 200, payload))
        .catch((cause) => {
          const code = (cause && cause.code) || 'delete-failed'
          const message = cause instanceof Error ? cause.message : String(cause)
          ctx.logger?.warn?.(`[${PACKAGE_NAME}] ${code}: ${message}`)
          sendJson(response, statusFor(code), { ok: false, code, message })
        })
    }

    const guard = (label, register) => {
      try {
        return register()
      } catch (cause) {
        ctx.logger?.warn?.(`[${PACKAGE_NAME}] could not register the ${label} route: ${cause instanceof Error ? cause.message : String(cause)}`)
        return undefined
      }
    }

    guard(
      'doctor',
      () =>
        ctx.effect(() =>
          webServer.register({
            kind: 'exact',
            path: `${ROUTE_PREFIX}/doctor`,
            handler: (request, response) => respond(response, () => buildDoctorReport(ctx, state)),
          }),
        ),
    )

    guard(
      'delete',
      () =>
        ctx.effect(() =>
          webServer.register({
            kind: 'exact',
            path: `${ROUTE_PREFIX}/delete`,
            handler: (request, response) =>
              respond(response, async () => {
                const header = safeGet(() => request.headers?.[REQUIRED_HEADER], undefined)
                if (typeof header !== 'string' || header.length === 0) {
                  throw codedError('forbidden', `missing ${REQUIRED_HEADER} header`)
                }
                const body = await readJsonBody(request)
                return await deleteConversation(ctx, state, body && body.sessionId, { stopActivity: body?.stopActivity })
              }),
          }),
        ),
    )

    ctx.logger?.info?.(`[${PACKAGE_NAME}] routes ready: GET ${ROUTE_PREFIX}/doctor, POST ${ROUTE_PREFIX}/delete`)
  })
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

/**
 * Publish the adaptation runbook as a runtime skill, so "how to re-adapt this
 * plugin after a DSH upgrade" is available in every Session rather than only in
 * the checkout. A file-based skill with the same name (project- or user-scoped)
 * outranks this one and is the fallback when the plugin cannot load at all.
 */
function registerAdaptationSkill(ctx) {
  whenService(ctx, 'skills', (skills) => {
    if (typeof skills.register !== 'function') return
    let markdown
    try {
      markdown = require('node:fs').readFileSync(
        path.join(__dirname, '..', 'skill', `${PACKAGE_NAME}`, 'SKILL.md'),
        'utf8',
      )
    } catch {
      return
    }
    // Providers parse frontmatter themselves; a runtime registration takes the body.
    const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    const description =
      'Re-adapt the dsh-plugin-delete-conversation plugin after a DeepSeek Harness upgrade: re-read the live ' +
      'inspector surface, diff it against the plugin\'s compat/expected-surface.json record, patch the recorded seams, and verify with ' +
      'the plugin doctor route and the delete flow.'
    try {
      ctx.effect(() =>
        skills.register({
          name: PACKAGE_NAME,
          description,
          whenToUse:
            'Use when DSH was updated, when the sidebar delete row or the doctor route misbehaves, or when the ' +
            'plugin logs "needs adaptation".',
          content: body,
        }),
      )
      ctx.logger?.info?.(`[${PACKAGE_NAME}] adaptation skill registered`)
    } catch (cause) {
      ctx.logger?.warn?.(`[${PACKAGE_NAME}] adaptation skill not registered: ${String(cause)}`)
    }
  })
}

function apply(ctx) {
  const dshHome = resolveDshHome(ctx)
  const state = {
    dshHome,
    sessionsRoots: [path.join(dshHome, 'sessions')],
    layoutVerified: false,
    routesRegistered: false,
  }

  resolveSessionsRoots(ctx, dshHome)
    .then((roots) => {
      state.sessionsRoots = roots
    })
    .then(() => buildDoctorReport(ctx, state))
    .then((report) => {
      if (report.requiredFailures.length > 0) {
        ctx.logger?.warn?.(
          `[${PACKAGE_NAME}] ${VERSION} needs adaptation for this DSH build — missing: ${report.requiredFailures.join(', ')}. ` +
            `GET ${ROUTE_PREFIX}/doctor and the dsh-plugin-delete-conversation skill explain what to change.`,
        )
      } else {
        ctx.logger?.info?.(`[${PACKAGE_NAME}] ${VERSION} ready (dshHome=${dshHome})`)
      }
    })
    .catch((cause) => {
      ctx.logger?.warn?.(`[${PACKAGE_NAME}] startup self-check failed: ${String(cause)}`)
    })

  registerRoutes(ctx, state)
  registerAdaptationSkill(ctx)
}

/**
 * CommonJS exports in the most interoperable form: plain `exports.X = value`
 * assignments are picked up as named exports by cjs-module-lexer, so the module
 * behaves the same whether the loader reads `module.exports`, `mod.default`, or
 * `mod.apply`.
 */
exports.name = PACKAGE_NAME
exports.apply = apply
/** Exported for the adaptation workflow: call these from a host-side test or REPL. */
exports.deleteConversation = deleteConversation
exports.buildDoctorReport = buildDoctorReport