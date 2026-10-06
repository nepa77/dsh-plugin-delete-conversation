/**
 * dsh-plugin-delete-conversation — Client half (browser bundle).
 *
 * This file is NOT compiled. DSH serves the bytes of `exports["./client"]` to the
 * browser, where the shell's lazy-CJS module table executes it: running the script
 * only registers the factory below; the factory runs at materialization with a
 * `require` bound to the frozen platform module table.
 *
 * Bundle contract (verified against the shipped tsdown client preset and the
 * published `@deepseek-ai/dsh-client-ui-workspace/lib/client.js`):
 *
 *   window.__ModuleLoader__.load({ id: '<package name>', factory: (require) => {
 *     var module = { exports: {} }; var exports = module.exports;
 *     Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
 *     ...                        // require() only the platform baseline
 *     return module.exports      // { apply, inject } — the Cordis plugin shape
 *   } })
 *
 * Deliberate compatibility choices, so a DSH upgrade stays cheap to absorb:
 *   - requires only "react" (a PLATFORM_MODULES baseline word) and no DSH UI
 *     package, so no `dsh.client.external` edge and no cross-plugin value import;
 *   - renders a plain `role="menuitem"` button — the exact shape the
 *     `sidebar.workspaces.session.menu.item` contract documents (the list's
 *     keyboard walk and focus return read the DOM, so any such button joins it);
 *   - styles through `var(--dsw-*, fallback)` pairs, so a renamed theme token
 *     degrades to the fallback colour instead of breaking;
 *   - talks to its own Host half over an ordinary HTTP route, because DSH's
 *     `ctx.remote` needs generated Typert artifacts and this plugin has no build.
 *
 * Seams used: the `slots` Client service (injected), the
 * `sidebar.workspaces.session.menu.item` list slot, its owner props
 * (`sessionId`, `displayTitle`) and its slot-injected `useMenuOpenState` hook.
 * All are recorded in `../compat/expected-surface.json`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-delete-conversation',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    // The shipped menu-row primitive: using it is what makes this row's font size,
    // spacing, icon cell, hover fill and keyboard behaviour identical to the
    // shipped rows instead of merely similar. It is a frozen platform baseline
    // word (PLATFORM_MODULES in the shell), so it needs no `dsh.client.external`
    // edge — and the require is guarded so a future DSH that drops it degrades to
    // the styled fallback below rather than failing the whole bundle.
    var primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') || null
    } catch (error) {
      primitives = null
    }
    var MenuItemButton = primitives && typeof primitives.MenuItemButton === 'function' ? primitives.MenuItemButton : null
    var TrashIcon = primitives && primitives.IconTrashOutlineRegular ? primitives.IconTrashOutlineRegular : null

    var SLOT = 'sidebar.workspaces.session.menu.item'
    var ROUTE = '/dsh-plugin-delete-conversation'
    var ROW_ID = 'delete-conversation'
    var ROW_ORDER = 500
    var REQUEST_HEADERS = {
      'content-type': 'application/json',
      'x-dsh-plugin-delete-conversation': '1',
    }
    var STYLE_ID = 'dsh-plugin-delete-conversation/row.css'
    // Only the fallback row uses this; the values mirror the shipped
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
      return chinese
        ? {
            idle: '删除会话',
            armed: '再次点击确认删除',
            busy: '正在删除…',
            failed: '删除失败',
            done: '已删除',
            restartHint: '该会话仍在 DSH 内存中，重启 DSH 后从列表消失',
          }
        : {
            idle: 'Delete session',
            armed: 'Click again to delete',
            busy: 'Deleting…',
            failed: 'Delete failed',
            done: 'Deleted',
            restartHint: 'Still held in DSH memory; restart DSH to drop it from the list',
          }
    }

    /** The slot owner supplies the open-state pair; the entry only needs its setter. */
    function useMenuSetOpen(props) {
      var hook = props.useMenuOpenState
      if (typeof hook !== 'function') return undefined
      try {
        var pair = hook()
        if (Array.isArray(pair) && typeof pair[1] === 'function') return pair[1]
        if (pair && typeof pair.setOpen === 'function') return pair.setOpen
        if (pair && typeof pair.close === 'function') return function () { pair.close() }
      } catch (error) {
        return undefined
      }
      return undefined
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

    function buildRow(ctx, text) {
      return function DeleteConversationRow(props) {
        var sessionId = props.sessionId
        var displayTitle = props.displayTitle || sessionId || ''
        var armed = React.useState(false)
        var phase = React.useState('idle')
        var message = React.useState('')
        var setMenuOpen = useMenuSetOpen(props)

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
          fetch(ROUTE + '/delete', {
            method: 'POST',
            headers: REQUEST_HEADERS,
            body: JSON.stringify({ sessionId: sessionId }),
          })
            .then(function (response) {
              return response.json().then(
                function (payload) {
                  return { status: response.status, payload: payload }
                },
                function () {
                  return { status: response.status, payload: null }
                },
              )
            })
            .then(function (result) {
              if (result.payload && result.payload.ok) {
                phase[1]('idle')
                // Nothing else on the surface moves, so close the menu only once
                // the Host confirmed; a failure keeps the row (and its reason) up.
                if (typeof setMenuOpen === 'function') setMenuOpen(false)
                var removed = result.payload.removed || {}
                if (removed.stillInMemory) {
                  // Gone from disk, but this DSH process still holds the Session in
                  // memory and no third-party plugin can dispose another owner's
                  // session — only a restart drops it from the list.
                  phase[1]('note')
                  message[1](text.restartHint)
                  return
                }
                // Nothing else to do here: the Host already told every consumer the
                // session is gone (`api-session/removed`) and rewrote the workspace
                // domain, so the sidebar drops the row on its own. Deliberately NO
                // page reload — that looked like DSH restarting itself.
                return
              }
              phase[1]('error')
              var reason = (result.payload && result.payload.message) || 'HTTP ' + result.status
              if (result.status === 404 || result.status === 405 || result.payload === null) {
                reason += ' — the Host route is not answering; check ' + ROUTE + '/doctor'
              }
              message[1](reason)
            })
            .catch(function (error) {
              phase[1]('error')
              message[1](String((error && error.message) || error))
            })
        }

        var label =
          phase[0] === 'busy'
            ? text.busy
            : phase[0] === 'error'
              ? text.failed
              : phase[0] === 'note'
                ? text.done
                : armed[0]
                  ? text.armed
                  : text.idle

        var hint =
          (phase[0] === 'error' || phase[0] === 'note') && message[0]
            ? React.createElement('span', { key: 'hint', className: 'dsh-delete-conversation-hint' }, message[0])
            : null
        var icon = TrashIcon !== null ? React.createElement(TrashIcon, { size: 14 }) : null

        // Preferred path: the shipped primitive renders the shipped markup, so this
        // row is identical to 重命名 / 归档对话 in font size (13px/20px), icon cell
        // (14x14), spacing and hover fill, and `danger` takes the red variant from
        // the theme instead of a hard-coded colour.
        if (MenuItemButton !== null) {
          var menuProps = { danger: true, disabled: phase[0] === 'busy', onSelect: activate }
          if (icon !== null) menuProps.icon = icon
          return React.createElement(
            MenuItemButton,
            menuProps,
            hint === null ? label : [React.createElement('span', { key: 'label' }, label), hint],
          )
        }

        // Fallback for a DSH that no longer exposes the primitive: the same row
        // shape, styled by this package's own stylesheet.
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
            icon === null
              ? null
              : React.createElement('span', { key: 'icon', className: 'dsh-delete-conversation-icon' }, icon),
            React.createElement('span', { key: 'label' }, label),
            hint,
          ],
        )
      }
    }

    /** Required services for the fiber; `slots` is the only one this plugin needs. */
    exports.inject = ['slots']

    exports.apply = function apply(ctx) {
      ensureStyles()
      var text = labels(ctx)
      whenService(ctx, 'slots', function (slots) {
        if (typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          console.error(
            '[dsh-plugin-delete-conversation] the slots service no longer looks like {inject, register}; ' +
              'see the dsh-plugin-delete-conversation skill and GET /dsh-plugin-delete-conversation/doctor',
          )
          return
        }
        slots.inject(SLOT, function () {
          return slots.register({ name: SLOT, id: ROW_ID, order: ROW_ORDER }, buildRow(ctx, text))
        })
      })
    }

    return module.exports
  },
})
