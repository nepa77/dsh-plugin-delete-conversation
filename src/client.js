/**
 * dsh-plugin-delete-conversation — Client half (browser bundle).
 *
 * This file is NOT compiled. DSH serves the bytes of `exports["./client"]` to the
 * browser, where the shell's lazy-CJS module table executes it: running the script
 * only registers the factory below; the factory runs at materialization with a
 * `require` bound to the frozen platform module table.
 *
 * TWO REGISTRATION PATHS, ONE ROW
 *   - DSH 0.2.2 moved the built-in Session actions to the data-driven context menu
 *     service (`ctx.contextMenus`), and re-labelled the old component slot
 *     `sidebar.workspaces.session.menu.item` as "legacy external rows, rendered
 *     before the built-in Archive action". This plugin therefore registers a
 *     **data action** for the `session` target on 0.2.2+ (danger styling, last
 *     position, icon through the keyed `contextMenu.icon` slot) and keeps the
 *     legacy component row only as a fallback for an older build without the
 *     service. The legacy row renders nothing while the data action is active, so
 *     the menu never shows two delete rows.
 *   - Selecting the action opens a confirmation dialog registered into
 *     `shell.overlay`, built from the shipped `Modal` + `Button` primitives — the
 *     same shape the shipped archive confirmation uses. Confirming posts to this
 *     plugin's own Host route.
 *
 * Compatibility choices, so a DSH upgrade stays cheap to absorb:
 *   - requires only platform baseline words (`react`,
 *     `@deepseek-ai/dsh-client-ui-primitives`) and reads every service through
 *     `ctx.get(name)` with feature detection;
 *   - every optional piece (context menu service, icon slot, Modal/Button) has a
 *     fallback path, so a renamed seam degrades this row instead of breaking the
 *     page;
 *   - talks to its own Host half over an ordinary HTTP route, because DSH's
 *     `ctx.remote` needs generated Typert artifacts and this plugin has no build.
 *
 * Seams used: client `slots`, `contextMenus.register`, the keyed slots
 * `contextMenu.icon` and `shell.overlay`, the `session` context-menu target, and
 * `MenuItemButton` / `IconTrashOutlineRegular` / `Modal` / `Button`. All are
 * recorded in `../compat/expected-surface.json`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-delete-conversation',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    // Guards: a future build that stops exposing the primitives degrades the row
    // instead of failing the whole bundle at materialization.
    var primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') || null
    } catch (error) {
      primitives = null
    }
    var MenuItemButton = primitives && typeof primitives.MenuItemButton === 'function' ? primitives.MenuItemButton : null
    var Modal = primitives && typeof primitives.Modal === 'function' ? primitives.Modal : null
    var Button = primitives && typeof primitives.Button === 'function' ? primitives.Button : null
    var TrashIcon = primitives && primitives.IconTrashOutlineRegular ? primitives.IconTrashOutlineRegular : null

    var ROUTE = '/dsh-plugin-delete-conversation'
    var REQUEST_HEADERS = {
      'content-type': 'application/json',
      'x-dsh-plugin-delete-conversation': '1',
    }
    /** Contribution id for one target family; also the id the catalog lists. */
    var CONTRIBUTION_ID = 'delete-conversation'
    var ACTION_ID = 'delete-session'
    /** After every shipped Session action (archive is 400 in the 0.2.2 menu). */
    var ACTION_ORDER = 900
    var ICON_KEY = 'dsh-plugin-delete-conversation.delete'
    var OVERLAY_ID = 'delete-conversation-confirm'
    var LEGACY_SLOT = 'sidebar.workspaces.session.menu.item'
    var LEGACY_ROW_ORDER = 500
    var STYLE_ID = 'dsh-plugin-delete-conversation/row.css'
    // Only the legacy fallback row uses this; values mirror the shipped
    // Menu.module.css row (.item 13px/20px, .itemIcon 14x14, .danger red).
    var CSS =
      '.dsh-delete-conversation-row{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;min-height:30px;padding:4px 8px;border:0;border-radius:var(--dsw-radius-md,6px);background:transparent;font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;color:var(--dsw-alias-state-error-primary,#e5534b)}' +
      '.dsh-delete-conversation-row:hover:not(:disabled),.dsh-delete-conversation-row:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(229,83,75,.12));outline:none}' +
      '.dsh-delete-conversation-row:disabled{opacity:.4;cursor:not-allowed}' +
      '.dsh-delete-conversation-icon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center}' +
      '.dsh-delete-conversation-icon svg{width:14px;height:14px}' +
      '.dsh-delete-conversation-hint{display:block;white-space:normal;font-size:11px;line-height:15px;opacity:.8;color:var(--dsw-alias-label-caption,inherit)}'

    /* ---------------------------------------------------------------- *
     * helpers
     * ---------------------------------------------------------------- */

    /** Resolve a service now, or as soon as it appears. */
    function whenService(ctx, name, whenReady) {
      var service = ctx.get(name)
      if (service !== undefined) {
        whenReady(service)
        return
      }
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject([name], function (scoped) {
            var ready = scoped.get(name)
            if (ready !== undefined) whenReady(ready)
          })
          return
        } catch (error) {
          /* fall through to polling */
        }
      }
      var attempts = 0
      var interval = setInterval(function () {
        attempts += 1
        var late = ctx.get(name)
        if (late !== undefined) {
          clearInterval(interval)
          whenReady(late)
        } else if (attempts > 80) {
          clearInterval(interval)
        }
      }, 250)
      ctx.effect(function () {
        return function () {
          clearInterval(interval)
        }
      })
    }

    /**
     * A bare `getSnapshot`/`subscribe` source. The renderer turns an inject face's
     * `hooks: { pending }` into a `usePending(selector)` prop, and it accepts a bare
     * source like this one, so the dialog needs no store package.
     */
    function createSource(initial) {
      var value = initial
      var listeners = new Set()
      return {
        getSnapshot: function () {
          return value
        },
        subscribe: function (listener) {
          listeners.add(listener)
          return function () {
            listeners.delete(listener)
          }
        },
        set: function (next) {
          if (Object.is(next, value)) return
          value = next
          listeners.forEach(function (listener) {
            try {
              listener()
            } catch (error) {
              /* a listener must not break the setter */
            }
          })
        },
      }
    }

    /** Resolve the active locale id without depending on one exact snapshot shape. */
    function localeId(ctx) {
      var candidates = []
      try {
        var locale = ctx.get('locale')
        if (locale !== undefined) {
          var snapshot = typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : undefined
          var current = typeof locale.getLocale === 'function' ? locale.getLocale() : undefined
          if (snapshot) candidates.push(snapshot.id, snapshot.locale, snapshot.current)
          if (current) candidates.push(current.id, current.locale)
        }
      } catch (error) {
        /* ignore */
      }
      if (typeof navigator !== 'undefined') candidates.push(navigator.language)
      if (typeof document !== 'undefined' && document.documentElement) {
        candidates.push(document.documentElement.lang)
      }
      for (var index = 0; index < candidates.length; index += 1) {
        if (typeof candidates[index] === 'string' && candidates[index].length > 0) return candidates[index]
      }
      return ''
    }

    function labels(ctx) {
      var id = String(localeId(ctx)).toLowerCase()
      var chinese = id === '' || id.indexOf('zh') === 0
      if (chinese) {
        return {
          menu: '删除会话',
          confirmTitle: '删除会话',
          confirmDescription: function (title) {
            return '「' + title + '」的日志、投影缓存与工作区归属都会被永久删除，无法恢复。'
          },
          confirm: '删除',
          cancel: '取消',
          close: '关闭',
          busy: '正在删除…',
          failed: '删除失败',
          deleted: '已删除会话',
          restartHint: '该会话仍在 DSH 内存中，重启 DSH 后从列表消失',
          confirmPlain: function (title) {
            return '删除会话「' + title + '」？\n\n日志、投影缓存与工作区归属都会被永久删除，无法恢复。'
          },
          armed: '再次点击确认删除',
          idle: '删除会话',
        }
      }
      return {
        menu: 'Delete session',
        confirmTitle: 'Delete session',
        confirmDescription: function (title) {
          return 'The log, projection cache and workspace membership of “' + title + '” are deleted permanently. This cannot be undone.'
        },
        confirm: 'Delete',
        cancel: 'Cancel',
        close: 'Close',
        busy: 'Deleting…',
        failed: 'Delete failed',
        deleted: 'Session deleted',
        restartHint: 'Still held in DSH memory; restart DSH to drop it from the list',
        confirmPlain: function (title) {
          return 'Delete session “' + title + '”?\n\nThe log, projection cache and workspace membership are deleted permanently.'
        },
        armed: 'Click again to confirm',
        idle: 'Delete session',
      }
    }

    function ensureStyles() {
      if (typeof document === 'undefined' || !document.head) return
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']') !== null) return
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-delete-conversation'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** `POST /delete`, always resolving to `{ status, payload }` so callers branch once. */
    function postDelete(sessionId) {
      return fetch(ROUTE + '/delete', {
        method: 'POST',
        headers: REQUEST_HEADERS,
        body: JSON.stringify({ sessionId: sessionId }),
      }).then(
        function (response) {
          return response.json().then(
            function (payload) {
              return { status: response.status, payload: payload }
            },
            function () {
              return { status: response.status, payload: null }
            },
          )
        },
        function (error) {
          return { status: 0, payload: null, transport: String((error && error.message) || error) }
        },
      )
    }

    function failureReason(result, text) {
      if (result.transport !== undefined) return result.transport
      var reason = (result.payload && result.payload.message) || 'HTTP ' + result.status
      if (result.status === 404 || result.status === 405 || result.payload === null) {
        reason += ' — the Host route is not answering; check ' + ROUTE + '/doctor'
      }
      return reason
    }

    /* ---------------------------------------------------------------- *
     * confirmation dialog (shell.overlay)
     * ---------------------------------------------------------------- */

    function makeConfirmDialog(text) {
      return function DeleteConversationDialog(props) {
        var request = props.usePending(function (value) {
          return value
        })
        if (request === null) return null
        var status = props.useStatus(function (value) {
          return value
        })
        var message = props.useMessage(function (value) {
          return value
        })
        var busy = status === 'busy'
        var footer = React.createElement(
          'div',
          { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
          [
            React.createElement(
              Button,
              { key: 'cancel', variant: 'outline', disabled: busy, onClick: props.cancel },
              text.cancel,
            ),
            React.createElement(
              Button,
              { key: 'confirm', variant: 'outline', disabled: busy, onClick: props.confirm },
              text.confirm,
            ),
          ],
        )
        var body = []
        if (busy) body.push(React.createElement('div', { key: 'status', role: 'status' }, text.busy))
        if (message) {
          body.push(
            React.createElement(
              'div',
              { key: 'failure', role: 'alert', style: { marginTop: '6px', color: 'var(--dsw-alias-state-error-primary, #e5534b)' } },
              message,
            ),
          )
        }
        return React.createElement(
          Modal,
          {
            open: true,
            onClose: props.cancel,
            closeLabel: text.close,
            title: text.confirmTitle,
            description: text.confirmDescription(request.displayTitle),
            footer: footer,
          },
          body.length === 0 ? null : body,
        )
      }
    }

    /* ---------------------------------------------------------------- *
     * legacy component row (DSH builds without ctx.contextMenus)
     * ---------------------------------------------------------------- */

    function makeLegacyRow(text) {
      return function DeleteConversationRow(props) {
        var sessionId = props.sessionId
        var displayTitle = props.displayTitle || sessionId || ''
        var armed = React.useState(false)
        var phase = React.useState('idle')
        var message = React.useState('')
        var hook = props.useMenuOpenState
        var setMenuOpen = undefined
        if (typeof hook === 'function') {
          try {
            var pair = hook()
            if (Array.isArray(pair) && typeof pair[1] === 'function') setMenuOpen = pair[1]
            else if (pair && typeof pair.setOpen === 'function') setMenuOpen = pair.setOpen
          } catch (error) {
            setMenuOpen = undefined
          }
        }

        React.useEffect(function () {
          if (!armed[0]) return undefined
          var timer = setTimeout(function () {
            armed[1](false)
          }, 6000)
          return function () {
            clearTimeout(timer)
          }
        }, [armed[0]])

        var activate = function (event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault()
          if (phase[0] === 'busy') return
          if (!armed[0]) {
            armed[1](true)
            phase[1]('idle')
            message[1]('')
            return
          }
          armed[1](false)
          phase[1]('busy')
          message[1]('')
          postDelete(sessionId).then(function (result) {
            if (result.payload && result.payload.ok) {
              phase[1]('idle')
              if (typeof setMenuOpen === 'function') setMenuOpen(false)
              return
            }
            phase[1]('error')
            message[1](failureReason(result, text))
          })
        }

        if (props.__dataActive === true) return null
        var label = phase[0] === 'busy' ? text.busy : phase[0] === 'error' ? text.failed : armed[0] ? text.armed : text.idle
        var icon = TrashIcon !== null ? React.createElement(TrashIcon, { size: 14 }) : null
        var hint =
          phase[0] === 'error' && message[0]
            ? React.createElement('span', { key: 'hint', className: 'dsh-delete-conversation-hint' }, message[0])
            : null
        if (MenuItemButton !== null) {
          var menuProps = { danger: true, disabled: phase[0] === 'busy', onSelect: activate }
          if (icon !== null) menuProps.icon = icon
          return React.createElement(
            MenuItemButton,
            menuProps,
            hint === null ? label : [React.createElement('span', { key: 'label' }, label), hint],
          )
        }
        return React.createElement(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: 'dsh-delete-conversation-row',
            title: displayTitle,
            disabled: phase[0] === 'busy',
            onClick: activate,
          },
          [
            icon === null ? null : React.createElement('span', { key: 'icon', className: 'dsh-delete-conversation-icon' }, icon),
            React.createElement('span', { key: 'label' }, label),
            hint,
          ],
        )
      }
    }

    /** Required services for the fiber; `slots` is the only one this plugin needs. */
    exports.inject = ['slots']

    exports.apply = function apply(ctx) {
      var text = labels(ctx)
      ensureStyles()

      // One dialog state for the whole page: at most one confirmation is pending.
      var pending = createSource(null)
      var status = createSource('idle')
      var message = createSource('')
      var dataActive = { value: false }

      var settle = function () {
        pending.set(null)
        status.set('idle')
        message.set('')
      }

      var notify = function (line, success) {
        var menus = ctx.get('contextMenus')
        if (menus !== undefined && typeof menus.notify === 'function') {
          try {
            menus.notify(line, success)
          } catch (error) {
            /* toast is a courtesy, not the result */
          }
        }
      }

      var runDelete = function (request) {
        if (request === null) return
        status.set('busy')
        message.set('')
        postDelete(request.sessionId).then(function (result) {
          if (result.payload && result.payload.ok) {
            settle()
            var stillInMemory = Boolean(result.payload.removed && result.payload.removed.stillInMemory)
            notify(stillInMemory ? text.restartHint : text.deleted, !stillInMemory)
            return
          }
          status.set('error')
          message.set(failureReason(result, text))
        })
      }

      var confirm = function () {
        if (status.getSnapshot() === 'busy') return
        runDelete(pending.getSnapshot())
      }

      var cancel = function () {
        if (status.getSnapshot() === 'busy') return
        settle()
      }

      var requestConfirm = function (sessionId, displayTitle) {
        var request = { sessionId: sessionId, displayTitle: displayTitle || sessionId }
        if (Modal !== null && Button !== null) {
          status.set('idle')
          message.set('')
          pending.set(request)
          return
        }
        // No dialog primitive in this build: fall back to the platform confirmation.
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm(text.confirmPlain(request.displayTitle))) return
          runDelete(request)
          return
        }
        pending.set(request)
      }

      /** 0.2.2+: one data action for the `session` target family. */
      var activateDataPath = function (menus) {
        if (dataActive.value) return
        if (menus === null || typeof menus !== 'object' || typeof menus.register !== 'function') return
        dataActive.value = true

        ctx.effect(function () {
          return menus.register({
            id: CONTRIBUTION_ID,
            target: 'session',
            order: ACTION_ORDER,
            resolve: function (value) {
              if (value === null || typeof value !== 'object' || typeof value.sessionId !== 'string') return []
              return [
                {
                  id: ACTION_ID,
                  label: text.menu,
                  icon: { key: ICON_KEY },
                  danger: true,
                  separatorBefore: true,
                  afterContent: true,
                  failureLabel: text.failed,
                  run: function () {
                    requestConfirm(value.sessionId, value.displayTitle)
                  },
                },
              ]
            },
          })
        })

        ctx.slots.inject('contextMenu.icon', function () {
          return ctx.slots.register({ name: 'contextMenu.icon', key: ICON_KEY }, function DeleteGlyph() {
            return TrashIcon === null ? null : React.createElement(TrashIcon, { size: 14 })
          })
        })

        if (Modal !== null && Button !== null) {
          ctx.slots.inject('shell.overlay', function () {
            return ctx.slots.register(
              {
                name: 'shell.overlay',
                id: OVERLAY_ID,
                inject: function () {
                  return {
                    hooks: { pending: pending, status: status, message: message },
                    confirm: confirm,
                    cancel: cancel,
                  }
                },
              },
              makeConfirmDialog(text),
            )
          })
        }
      }

      var menus = ctx.get('contextMenus')
      if (menus !== undefined) activateDataPath(menus)
      else whenService(ctx, 'contextMenus', activateDataPath)

      // The legacy row stays registered as the fallback for an older build; it
      // renders nothing as soon as the data action is active.
      whenService(ctx, 'slots', function (slots) {
        if (typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          console.error(
            '[dsh-plugin-delete-conversation] the slots service no longer looks like {inject, register}; ' +
              'see the dsh-plugin-delete-conversation skill and GET ' + ROUTE + '/doctor',
          )
          return
        }
        slots.inject(LEGACY_SLOT, function () {
          var Row = makeLegacyRow(text)
          var Guarded = function GuardedLegacyRow(props) {
            if (dataActive.value) return null
            return React.createElement(Row, props)
          }
          return slots.register({ name: LEGACY_SLOT, id: CONTRIBUTION_ID, order: LEGACY_ROW_ORDER }, Guarded)
        })
      })
    }

    return module.exports
  },
})
