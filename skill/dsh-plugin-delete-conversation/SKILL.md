---
name: dsh-plugin-delete-conversation
description: 当「删除会话」插件的菜单行不工作、消失或报错，或 Harness 升级之后需要重新适配时使用。本手册说明该重新读取哪些实时接口、记录下来的期望形状是什么、该改哪个调用点、按什么顺序验证，以及怎么回滚。
---

# 重新适配 dsh-plugin-delete-conversation

Harness 的插件接口不承诺长期稳定，而本插件必须触碰一些 Harness 没有当作公开 API 的内部能力（会话持久化的磁盘布局、工作区存储域、会话停止路径）。因此它按"随时可以重新适配"来设计：宿主半边不导入任何 `@deepseek-ai/*` 包，所有能力都用 `ctx.get(名称)` 取用并做能力检测；也不声明 `@deepseek-ai/dsh-*` 的 peer 依赖，升级不会因为版本门被拒绝加载。

**版本 0.1.5。** 本插件不与其他 bundle 共享代码，所以 Harness 升级只会影响 `compat/expected-surface.json` 里列出的那些接口面。

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
| `ctx.get('sessionPersistence').stat(id)` | 读 header（`cwd`）并在删除后复核 | 可选。注意这个接口在任何版本都是只追加的：**没有删除方法**，日志由插件自己删 |
| 会话日志的磁盘布局 | `<dshHome>/sessions/<projectKey(cwd)>/<sessionId>/session.v*.jsonl[.zstd]` | 布局变化时改 `findSessionDirs()`；插件按 id 在候选根目录下扫描，不自己计算 projectKey。JSONL 后端的根来自一个必填 Config 字段且没有环境变量，因此候选根包括 `DSH_SESSIONS_DIR`、`DSH_SESSION_ROOT`、`ctx.config.sessionsRoot`、`<dshHome>/sessions`，以及 `dshHome` 下任何名为 `sessions` 的目录 |
| `session_projcache` 域 | 域 `session_projcache` v7，`per-record` 布局，表 `sessions`，键是 SessionId | 域不可用时自动退化为直接删 `<dshHome>/storages/session_projcache/sessions/<id>.json`（派生数据） |
| `ctx.get('webServer').register({kind,path,handler})` | `handler(request, response)`，Node 风格的 request 与带 `writeHead/setHeader/end` 的 response | 路由形状变化：浏览器半边会收到 404/405 并提示去看 doctor。也可以迁移到 `connection` 的 `POST api/<endpoint>` JSON-RPC；若愿意引入构建步骤，可以改用 `@Remote` + `ctx.remote` |
| `ctx.emit('api-session/removed', sessionId)` | Harness 自带的"会话已离开存活注册表"通知，各消费方据此重建列表 | 事件改名时，删除后列表可能残留，需要改成新的通知方式 |
| `ctx.get('skills').register({name,description,content})` | 把本手册注册成运行时技能 | 可选，失败只记录日志 |

### 客户端侧

| 依赖面 | 期望 | 失效时怎么办 |
|---|---|---|
| 槽位 `sidebar.workspaces.session.menu.item` | `list` 类型、`root` 作用域；注册项 `{name,id,order}`（`id` 必填）；owner props 是 `{sessionId, displayTitle}`；槽位注入钩子 `useMenuOpenState` 返回 `[open, setOpen]`；每条必须渲染一个 `role="menuitem"` 按钮 | 槽位改名或类型变化：用 `Slots.listSubTree` 找新的会话菜单槽位，改 `src/client.js` 顶部的 `SLOT`；关闭菜单的取值方式（当前是 `props.useMenuOpenState()[1]`）也要跟着改 |
| `@deepseek-ai/dsh-client-ui-primitives` 的 `MenuItemButton`（`danger` 变体）与 `IconTrashOutlineRegular` | 平台基线模块，无需 `dsh.client.external`；菜单行的字号 13px / 行高 20px、图标格 14×14、红字与红色悬停都来自它 | 组件或图标改名：`require` 已做保护，会自动退化成本插件自带的同规格按钮与样式；也可以按 client `Builtin.listBuiltins` 与实时包内容改用新的导出名 |
| bundle 加载约定 | 一个 classic script 只注册工厂：`window.__ModuleLoader__.load({ id, factory })`，工厂返回 `{ apply, inject }`，并且只能 `require()` 平台基线模块 | 约定变化时菜单行会从槽位占用者列表里消失——先用 `Slots.listSubTree` 确认，再改 `src/client.js` 的包装层，或改为真正的构建产物 |
| 主题变量 | `--dsw-alias-state-error-primary`、`--dsw-alias-interactive-bg-hover-danger`、`--dsw-alias-label-caption` | 都带字面量兜底，改名只影响颜色，不会让行失效；用 client `Theme.listTokens` 核对新名字 |

## 改动点

| 文件 | 位置 | 用途 |
|---|---|---|
| `src/index.js` | `deleteConversation()` | 删除步骤与顺序 |
| `src/index.js` | `buildDoctorReport()` | 依赖面清单；**新增依赖面必须同时加进这里** |
| `src/index.js` | `resolveSessionsRoots()`、`findSessionDirs()` | 日志根目录候选与定位 |
| `src/index.js` | `registerRoutes()` | 两个 HTTP 路由与请求头守卫 |
| `src/index.js` | `VERSION`、`ADAPTED_FOR` | 版本与适配基准 |
| `src/client.js` | `SLOT`、`ROW_ID`、`ROW_ORDER`、`labels()` | 菜单行的位置与文案 |
| `src/client.js` | `buildRow()`、`CSS` | 行的渲染与降级样式 |
| `compat/expected-surface.json` | `adaptedFor` 与各 `seams[]` | 契约记录，与代码同步更新 |

## 验证顺序

1. 语法：`node --check src/index.js` 与 `node --check src/client.js`。
2. 离线测试：`node test/delete-conversation.test.mjs`（零依赖，覆盖顺序保证与失败即中止的全部路径）。
3. 文档路径：`node tools/check-readme-paths.mjs`（README 里提到的每个相对路径、以及 `package.json` 的 `files` 每一项都必须存在）。
4. 重启 Harness 后打开 doctor，`requiredFailures` 必须为空。
5. 真实删除一次：新建一个一次性会话，点两次菜单行，确认它从列表消失，并用 `node tools/verify-deleted.mjs --diff before.json` 确认日志目录、缓存文件、工作区记录三处都干净。
6. 运行中的会话：在一个正在回答的会话上删一次，确认先停止再删除，且响应里 `stillInMemory` 为 `false`（若为 `true`，界面会提示需要重启 Harness——这是 Harness 自身的内存持有，不是本插件的缺陷）。
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
