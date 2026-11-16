---
name: dsh-plugin-delete-conversation
description: 当「删除会话」插件的菜单行不工作、消失或报错，或 Harness 升级之后需要重新适配时使用。本手册说明该重新读取哪些实时接口、记录下来的期望形状是什么、该改哪个调用点、按什么顺序验证，以及怎么回滚。
---

# 重新适配 dsh-plugin-delete-conversation

Harness 的插件接口不承诺长期稳定，而本插件必须触碰一些 Harness 没有当作公开 API 的内部能力（会话持久化的磁盘布局、工作区存储域、会话停止路径）。因此它按"随时可以重新适配"来设计：宿主半边不导入任何 `@deepseek-ai/*` 包，所有能力都用 `ctx.get(名称)` 取用并做能力检测；也不声明 `@deepseek-ai/dsh-*` 的 peer 依赖，升级不会因为版本门被拒绝加载。

**版本 0.1.7。** 本插件不与其他 bundle 共享代码，所以 Harness 升级只会影响 `compat/expected-surface.json` 里列出的那些接口面。

## 收到问题报告时的第一步

先读插件自己的结论，而不是猜：

```powershell
curl.exe -s http://127.0.0.1:19387/dsh-plugin-delete-conversation/doctor
```

- 每条检查都有 `level`：`required` 缺失即功能不可用，`fallback` / `optional` 缺失只是某一步降级，`info` 是记录性信息。
- `requiredFailures` 就是"这次升级需要改哪里"的清单；启动日志里也会有一行 `needs adaptation for this DSH build — missing: …`。
- 若 doctor 路由本身 404，说明宿主半边没有激活：先确认 profile 里有 `delete-conversation` 这一行，再看启动日志里这个 fiber 的报错。

## 第一步：重新采集实时契约

`compat/expected-surface.json` 是**记录**，不是契约；契约永远是运行中的实时接口。用 `cordis_inspect_list` 确认当前有哪些 Provider，然后按需查询：

| 需要确认的东西 | 查询方式 |
|---|---|
| 宿主服务及其方法签名 | host `Service.listService`（不带 `service` 得到目录，带上某个 `service` 得到它的完整契约与引用类型） |
| `storageDomain` / `workspaceRegistry` / `sessions` / `agents` / `sessionPersistence` / `webServer` / `skills` | 同上，`service` 设为对应键名 |
| 宿主事件（`workspace/session-stop`、`domain/changed`） | host `Event.listEvents`，再带上具体 `event` 拿到监听签名 |
| 插件的 loader 行是否存活 | host `Config.listConfigs`，`name` 设为 `dsh-plugin-delete-conversation` |
| 侧边栏槽位契约与当前占用者 | client `Slots.listSubTree`，`root` 设为 `sidebar.workspaces.session.menu.item` |
| 客户端服务/内置符号/主题变量 | client `Service.listService`、`Builtin.listBuiltins`、`Theme.listTokens` |

采集完与 `compat/expected-surface.json` 的每个 `expected` 逐条对比，只改动真正变化的地方。

## 依赖面清单

### 宿主侧

| 依赖面 | 期望 | 失效时怎么办 |
|---|---|---|
| `ctx.get('storageDomain').get('workspace')` | 域 `workspace` v2，`single` 布局；`table('workspaces')` 的记录是 `{path,title,sessionIds,createdAt,updatedAt}`；`global` 是 `{initialized,defaultWorkspaceId,workspaceIds,archivedSessionIds,pinnedSessionIds,pendingMutation?}` | 域/表改名或版本被拒：删除会以 `workspace-domain-unavailable` 中止（什么都不动）。按实时契约改域名、表名与字段名 |
| `workspaceRegistry.archiveSession(id, {stopActivity:true})` | 先写归档闸门，再发 `workspace/session-stop`；这个顺序是安全性的来源 | 方法改名或消失：必须保留"先写闸门、再停止"的顺序。若只能自己发事件，payload 是 `{sessionId}`，用 `ctx.parallel` 派发 |
| `workspaceRegistry.list()` → `Workspace.detachSession(id)` | 唯一会从 `sessionIds` 里移除会话的官方写入路径 | 消失时自动退化为直接写 `workspaces` 表（保留所有未修改字段） |
| `workspaceRegistry.unarchiveSession` / `unpinSession` | 清理归档/置顶归属，走 registry 自己的串行写链 | 消失时退化为直接写域 global，并等 `pendingMutation` 结束 |
| `ctx.get('sessions').get(id)`、`ctx.get('agents').get(id)?.status` | 判断会话是否存活、回合是否仍在运行 | 缺失时无法判断运行状态，应把缺失当成 `required`，不要盲删 |
| `ctx.get('sessionPersistence').stat(id)` | 读 header（`cwd`）并在删除后复核；0.2.1 起快照多了一个 `formatStatus?: 'current' \| 'migration-required'`，只作信息用 | 可选。注意这个接口在任何版本都是只追加的：**没有删除方法**，日志由插件自己删 |
| 会话日志的磁盘布局 | `<dshHome>/sessions/<projectKey(cwd)>/<sessionId>/session.v*.jsonl[.zstd]` | 布局变化时改 `findSessionDirs()`；插件按 id 在候选根目录下扫描，不自己计算 projectKey。JSONL 后端的根来自一个必填 Config 字段且没有环境变量，因此候选根包括 `DSH_SESSIONS_DIR`、`DSH_SESSION_ROOT`、`ctx.config.sessionsRoot`、`<dshHome>/sessions`，以及 `dshHome` 下任何名为 `sessions` 的目录 |
| `session_projcache` 域 | 域 `session_projcache` v7，`per-record` 布局，表 `sessions`，键是 SessionId | 域不可用时自动退化为直接删 `<dshHome>/storages/session_projcache/sessions/<id>.json`（派生数据） |
| `ctx.get('webServer').register({kind,path,handler})` | `handler(request, response)`，Node 风格的 request 与带 `writeHead/setHeader/end` 的 response | 路由形状变化：浏览器半边会收到 404/405 并提示去看 doctor。也可以迁移到 `connection` 的 `POST api/<endpoint>` JSON-RPC；若愿意引入构建步骤，可以改用 `@Remote` + `ctx.remote` |
| `ctx.emit('api-session/removed', sessionId)` | Harness 自带的"会话已离开存活注册表"通知，各消费方据此重建列表 | 事件改名时，删除后列表可能残留，需要改成新的通知方式 |
| `ctx.get('skills').register({name,description,source,content})` | 把本手册注册成运行时技能。`source` 是**必填**字符串（`'runtime'`），缺了不会注册失败，但每次加载都会报 `loaded skill "<name>" source must be a string` | 可选，失败只记录日志；若技能能出现在目录里却加载失败，先查 `source` |

### 客户端侧

| 依赖面 | 期望 | 失效时怎么办 |
|---|---|---|
| `ctx.get('contextMenus')`（0.2.2 起） | 右键菜单服务是 `ctx.provide` 的上下文成员（**不是** Cordis Service，`Service.listService` 目录里查不到）。`register({ id, target: 'session', order, resolve })` 返回注销器；`resolve(value, signal)` 返回 `MenuAction[]`，字段有 `id` / `label` / `icon?: {key,src?}` / `danger?` / `separatorBefore?` / `afterContent?` / `children?` / `failureLabel?` / `run`。`target: 'session'` 的 value 是 `{ sessionId, displayTitle }`（`ContextMenuTargetMap`） | 服务缺失（0.2.1 及更早）：插件自动退回旧式组件行，功能不丢。字段改名：按 `packages/client/ui-context-menu/src/client/types.ts` 改 `activateDataPath()` 里的动作对象 |
| keyed Slot `contextMenu.icon` | 动作图标不再接受 React 节点，而是 `{ key }`；用 `ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({ name, key }, Icon))` 注册对应组件 | 槽位改名：改 `ICON_KEY` 与 `slots.inject` 的名字；图标组件永远返回 `null` 也不会崩 |
| keyed Slot `shell.overlay` + `Modal` / `Button` | 确认框注册在 `shell.overlay`（`list`），`inject` 面提供 `hooks: { pending, status, message }`（裸 `getSnapshot`/`subscribe` 源即可，渲染器会生成 `usePending(selector)` 等）与 `confirm`/`cancel`；弹窗用 `Modal({open,onClose,closeLabel,title,description,footer})` + `Button({variant:'outline',disabled,onClick})` 渲染，与内置归档确认框同形 | `Modal`/`Button` 缺失：`requestConfirm()` 退回 `window.confirm()`。`shell.overlay` 改名：确认框不再出现，必须改成新的 overlay 槽位 |
| 旧式槽位 `sidebar.workspaces.session.menu.item`（回退用） | 0.2.2 起被标注为"legacy external rows，渲染在内置 Archive 动作之前"，内置动作已迁到 `ctx.contextMenus`。本插件只在 `contextMenus` 缺失时用它，`dataActive` 为真时该组件返回 `null`，所以菜单里永远只有一项 | 只在旧版 Harness 生效；新版只要数据动作注册成功就不再渲染 |
| `@deepseek-ai/dsh-client-ui-primitives` | 平台基线模块，无需 `dsh.client.external`。用 `MenuItemButton`（仅回退行）、`IconTrashOutlineRegular`、`Modal`、`Button` | 导出改名：`require` 已做保护，行与确认框各自的降级路径见上；可用 client `Builtin.listBuiltins` 与安装包 `src/index.ts` 核对导出名 |
| bundle 加载约定 | 一个 classic script 只注册工厂：`window.__ModuleLoader__.load({ id, factory })`，工厂返回 `{ apply, inject }`，并且只能 `require()` 平台基线模块 | 约定变化时菜单动作与回退行都不会出现——先用 `Slots.listSubTree` 与 `contextMenus` 的注册情况确认，再改 `src/client.js` 的包装层，或改为真正的构建产物 |
| 主题变量 | `--dsw-alias-state-error-primary`、`--dsw-alias-interactive-bg-hover-danger`、`--dsw-alias-label-caption` | 都带字面量兜底，改名只影响颜色；用 client `Theme.listTokens` 核对新名字 |

## 最近一次适配的记录（0.2.1-rc.2 → 0.2.2-rc.3）

这次升级的完整结论也记在 `compat/expected-surface.json` 的 `lastUpgradeDiff` 里，可作为下一次的参照。判断顺序：先用 `plugin_manager list_version_exemptions` 拿到 `runtimeVersion`，再跑 doctor，然后读安装目录里的 `docs/upgrade-guide/README.md` 索引挑出与插件依赖面相关的 guide，最后按上面"第一步"重采实时契约，只改真正变了的那一处。

| 变化 | 影响 | 处理 |
|---|---|---|
| 会话菜单重构：内置动作迁到数据驱动的 `ctx.contextMenus`（`packages/client/ui-context-menu`），旧的 `sidebar.workspaces.session.menu.item` 降级为"legacy external rows，渲染在内置 Archive 之前" | **本插件的行会跑到菜单最前面**，与"删除应该在最下面"的约定冲突 | 改为注册 `target: 'session'` 的数据动作（`order: 900` + `afterContent`），旧组件行保留为回退并加 `dataActive` 空渲染守卫 |
| 动作图标改为 `{ key }` + keyed Slot `contextMenu.icon`，不再接受 React 节点 | 原来直接在行里画图标的方式不适用于数据动作 | 注册 `ICON_KEY` 对应的图标组件 |
| `MenuActionView` 支持 `danger` / `separatorBefore` / `afterContent` | 红色与分组分隔线仍可保留 | 数据动作上直接声明 |
| 确认交互：数据动作只有 `run`，没有行内状态 | 原来的"点两次"确认不可用 | 注册 `shell.overlay` 确认框（`Modal` + `Button`），`run` 只负责请求确认 |
| 归档现在可能删除会话的干净工作树（`v0.2.2-rc.1/archive-worktrees`） | 删除是"彻底删除"，工作树也应随之清理 | 归档/停止前置改为**对冷会话也执行**（best-effort），失败只记 warning；后续任何失败都会回滚闸门 |
| 会话日志仍是 `session.v4.jsonl.zstd`；`workspace` 域仍 v2；`session_projcache` 仍 v7；`api-session/removed`、`webServer.register`、`sessionPersistence` 的"没有删除方法"都没变 | 宿主半边无需改动 | doctor 全绿 + 真实删除一次确认 |

## 改动点

| 文件 | 位置 | 用途 |
|---|---|---|
| `src/index.js` | `deleteConversation()` | 删除步骤与顺序；归档前置 + 失败回滚闸门 |
| `src/index.js` | `buildDoctorReport()` | 依赖面清单；**新增依赖面必须同时加进这里** |
| `src/index.js` | `resolveSessionsRoots()`、`findSessionDirs()` | 日志根目录候选与定位 |
| `src/index.js` | `registerRoutes()` | 两个 HTTP 路由与请求头守卫 |
| `src/index.js` | `VERSION`、`ADAPTED_FOR` | 版本与适配基准 |
| `src/client.js` | `activateDataPath()` | 0.2.2+ 的右键菜单动作、图标槽位、确认框注册 |
| `src/client.js` | `makeConfirmDialog()`、`createSource()` | 确认框与它的弹窗状态源 |
| `src/client.js` | `makeLegacyRow()`、`CSS` | 旧版回退行与降级样式 |
| `src/client.js` | `CONTRIBUTION_ID`、`ACTION_ORDER`、`ICON_KEY`、`OVERLAY_ID`、`LEGACY_SLOT`、`labels()` | 位置、图标与文案 |
| `compat/expected-surface.json` | `adaptedFor` 与各 `seams[]` | 契约记录，与代码同步更新 |

## 验证顺序

1. 语法：`node --check src/index.js` 与 `node --check src/client.js`。
2. 离线测试：`node test/delete-conversation.test.mjs`（零依赖，覆盖顺序保证与失败即中止的全部路径）。
3. 文档路径：`node tools/check-readme-paths.mjs`（README 里提到的每个相对路径、以及 `package.json` 的 `files` 每一项都必须存在）。
4. 重启 Harness 后打开 doctor，`requiredFailures` 必须为空。
5. 真实删除一次：新建一个一次性会话，打开 `…` 菜单确认「删除会话」在最后、带红色图标与分组线，选中后出现确认框，点删除；用 `node tools/verify-deleted.mjs --diff before.json` 确认日志目录、缓存文件、工作区记录三处都干净。
6. 运行中的会话：在一个正在回答的会话上删一次，确认先停止再删除，且响应里 `stillInMemory` 为 `false`（若为 `true`，界面会提示需要重启 Harness——这是 Harness 自身的内存持有，不是本插件的缺陷）。
7. 数据动作注册情况：client `Slots.listSubTree` 查 `contextMenu.content` 时，`sidebar.workspaces.session.menu.item` 里不应再靠它显示；`contextMenus` 的贡献可用 `ctx.contextMenus.registeredKinds` 或菜单本身确认。回退路径（旧版 Harness）只在该服务缺失时启用。
7. 路由守卫：不带自定义请求头 POST 一次，必须得到 `403`。
8. 更新 `VERSION`、`package.json` 的版本号与 `compat/expected-surface.json` 的 `adaptedFor`。

## 回滚

- 停用而不是删除数据：`dsh plugin --profile <profile> remove dsh-plugin-delete-conversation`，或在 profile 的 `cordis.patch.yml` 给 `delete-conversation` 这一行加 `disabled: true`。
- 归档/置顶的副作用由插件自己清理；若中途被打断，Harness 自带的"取消归档 / 取消置顶"仍然可用。
- 浏览器半边出问题时，客户端模块注册表会在 Plugins 页报告该行的失败并提供重试，不影响宿主状态。

## 红线

- 宿主半边**不要** `import`/`require` 任何 `@deepseek-ai/dsh-*` 包：这个包在 profile 里没有依赖树，运行时导入会直接让 fiber 失败。
- **不要**在回合仍在运行时删除日志，也**不要**跳过"先写归档闸门"这一步。
- **不要**删除附件对象：它们内容寻址、被分叉共享。
- **不要**在 Harness 运行时直接改写 `storages/workspace.json` 或域文档；只能用实时域句柄或官方 registry 方法。
- **不要**为了省事把某个能力从 doctor 里去掉；doctor 的完整性就是这个插件的可维护性。
