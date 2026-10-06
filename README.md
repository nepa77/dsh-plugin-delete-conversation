# dsh-plugin-delete-conversation

**DeepSeek Harness 的「删除会话」插件**：在侧边栏的会话菜单里补上一个真正的删除动作，点两次即把该会话连同它的日志、缓存与工作区归属一起从磁盘上移除。

Harness 本身只提供归档：归档会把会话移出列表，但完整保留日志，随时可以取消归档恢复。它没有任何删除会话的接口——会话持久化层按设计只追加，官方说明里明确表示不存在删除会话文件的代码路径。本插件补上这个缺失的能力。

## 界面在哪里

侧边栏把鼠标移到任意会话上，打开 `…` 菜单：

| 菜单项 | 内容 |
|---|---|
| 前四项（Harness 自带） | 置顶会话 / 重命名 / 分叉会话 / 归档会话 |
| 第五项（本插件） | **红色垃圾桶图标 + 删除会话** |

- 字号、行高、图标格、间距与悬停底色都直接使用 Harness 自带的菜单行组件（`MenuItemButton` 的 `danger` 变体）与图标（`IconTrashOutlineRegular`），因此与上面几行完全一致，并跟随主题的深浅色。
- **需要点两次**：第一次点，文字变成「再次点击确认删除」，6 秒内不点会自动还原；第二次才真正执行。
- 删除失败时这一行就地显示原因，不会静默失败。

## 删除范围

| 对象 | 位置 | 处理方式 |
|---|---|---|
| 正在运行的工作（回合、后台任务、子智能体、定时提醒） | — | 先走 Harness 自带的归档停止路径：先写持久化闸门，再发 `workspace/session-stop` |
| 事件日志 | `<dshHome>/sessions/<项目>/<sessionId>/`（`session.v*.jsonl[.zstd]`） | 直接删除该目录（Harness 没有对应接口） |
| 投影缓存 | `session_projcache` 域 → `<dshHome>/storages/session_projcache/sessions/<id>.json` | 通过存储域删除该记录 |
| 工作区归属 | `workspace` 域的 `workspaces` 表 `sessionIds` | 优先调用 `Workspace.detachSession` |
| 归档 / 置顶归属 | `workspace` 域 global | `unarchiveSession` + `unpinSession`，**刻意放在最后**，让停止闸门活过物理删除 |

**有意不删的内容**：

- `<dshHome>/attachments/` 下的附件对象是内容寻址的，并且被分叉共享，Harness 自身也不回收；回收它们需要引用计数，本插件不做。
- 搜索索引（SQLite）是派生数据，会在下一次稳定观测时按持久化列表自行对账。

## 安全设计

- **先检查再动手**：所有必需依赖面在写入任何东西之前检查一遍，缺任何一项就以明确的错误码中止，会话保持原样。
- **先停再删**：仍在运行的会话走 Harness 自带的停止路径，并轮询到运行状态结束；停不下来就绝不删。
- **先删日志，再改列表**：日志删不掉时（例如 Windows 上文件被占用），工作区列表保持原样，不会留下"列表里还在、文件已经没了"的幽灵会话。
- **删完通知**：成功后向 Harness 发出 `api-session/removed`，各消费方据此重建列表，被删除的会话不会残留在"未分组"里。
- **网页打不到**：删除路由要求一个自定义请求头，跨站页面无法在不触发 CORS 预检的情况下设置它。这不是对本机其它进程的防护——那些进程本来就能直接读写会话文件。

## 安装

前置条件：Harness 桌面版至少启动过一次，`<dshHome>`（Windows 上通常是 `C:\Users\<用户名>\.dsh`）下已经有 `profiles/desktop`。

把插件目录放到一个**长期不变**的位置：profile 记录的是**绝对路径**，之后移动目录需要重新安装。

### A) 指向源码目录

```sh
git clone https://github.com/nepa77/dsh-plugin-delete-conversation.git
dsh plugin --profile desktop add /path/to/dsh-plugin-delete-conversation
```

没有 CLI 时，用界面上的 **Plugins（插件）** 页安装同一个目录；也可以在一个 Harness 会话里用一句话交给 agent 处理——它使用内置的 `plugin_manager`。

### B) 从 release 的压缩包装

每个 release 携带两个自包含的产物，内容都由 `package.json` 的 `files` 列表决定：

| 产物 | 用途 |
|---|---|
| `dsh-plugin-delete-conversation-<版本>.zip` | 解压即得到一个目录，最省事 |
| `dsh-plugin-delete-conversation-<版本>.tgz` | npm/pnpm 打包格式，适合只传一个文件 |

```sh
# 解压后指向目录
dsh plugin --profile desktop add /path/to/dsh-plugin-delete-conversation

# 或者直接从 tarball 安装
dsh plugin --profile desktop add /path/to/dsh-plugin-delete-conversation-0.1.5.tgz
```

安装完成后**重启 Harness**：宿主半边只在启动时加载。这个插件不需要 `npm install`，也没有构建步骤。

## 使用

1. 侧边栏 → 某个会话 → `…` → **删除会话** → 再点一次。
2. 该会话从列表消失；磁盘上的日志、投影缓存与工作区归属一并清除。

也可以直接调用 HTTP 接口，便于脚本化：

```sh
curl -X POST http://127.0.0.1:<端口>/dsh-plugin-delete-conversation/delete \
  -H 'content-type: application/json' \
  -H 'x-dsh-plugin-delete-conversation: 1' \
  -d '{"sessionId":"session-0123abcd-..."}'
```

端口与你的 Harness 界面一致。成功时返回：

```json
{
  "ok": true,
  "sessionId": "session-…",
  "removed": {
    "stoppedActivity": true,
    "logDirectories": ["…"],
    "projectionCacheEntry": true,
    "detachedFromWorkspaces": ["…"],
    "domainGlobalFields": ["archivedSessionIds"],
    "notified": true,
    "stillInMemory": false
  },
  "warnings": []
}
```

错误码：`400 bad-session-id`、`403 forbidden`（缺少自定义请求头）、`409 session-running`、`503`（依赖面不可用）、`500 log-removal-failed`。

## 验证

### 运行时体检

`GET /dsh-plugin-delete-conversation/doctor` 返回每一个依赖面的实时结论，每条包含 `level`（`required` / `fallback` / `optional` / `info`）、`ok` 与 `detail`：

```sh
curl.exe -s http://127.0.0.1:<端口>/dsh-plugin-delete-conversation/doctor
```

`requiredFailures` 为空，表示这台机器上的功能完整。

### 证明删干净了

会话 id 在界面上不可见，所以推荐先拍快照、删完再比对：

```sh
node tools/verify-deleted.mjs --snapshot before.json   # 删除之前
node tools/verify-deleted.mjs --diff before.json       # 删除之后：哪些会话消失、三处是否都干净
node tools/verify-deleted.mjs --list                   # 全部会话：id ↔ 标题 ↔ 首句 ↔ 缓存与字节数
node tools/verify-deleted.mjs --title 关键词            # 按标题查一个会话的现状
```

它检查的三处就是"删除范围"表里的全部落点：日志目录、投影缓存文件、工作区记录与归档/置顶集合。

### 本机联调（Windows）

```powershell
pwsh -File tools/verify-live.ps1 -Base http://127.0.0.1:<端口>
```

### 离线测试

```sh
node test/delete-conversation.test.mjs
```

零依赖，用一个假的 Harness 组合验证算法与顺序保证：先停后删、停不下来绝不删、日志删不掉绝不动列表、缺依赖面即拒绝、伪造的会话 id 不动数据、没有 registry 接口时的存储域兜底。

## 兼容性与适配

Harness 的插件接口不承诺长期稳定，本插件针对这一点设计：

- 宿主半边**不导入任何 `@deepseek-ai/*` 包**，所有能力都用 `ctx.get(名称)` 取用并做能力检测，所以某个接口改名或消失时，降级的是这个插件，而不是整个 profile 的启动。
- **故意不声明 `@deepseek-ai/dsh-*` 的 peer 依赖**，因此升级 Harness 不会因为版本门被拒绝加载；真正的兼容性检查是 doctor。

Harness 升级之后：

| 材料 | 作用 |
|---|---|
| `GET /dsh-plugin-delete-conversation/doctor` | `requiredFailures` 就是"这次升级需要改哪里"的清单 |
| `skill/dsh-plugin-delete-conversation/SKILL.md` | 适配手册：重跑哪些实时检查、与契约记录 diff 什么、改哪个调用点、按什么顺序验证、如何回滚 |
| `compat/expected-surface.json` | 记录下来的依赖面契约：期望形状、使用位置、失效模式、重新采集方法 |
| `test/delete-conversation.test.mjs` | 改完立刻知道有没有改坏 |

插件加载成功后会把适配手册注册成运行时技能，因此在任意 Harness 会话里都可以直接让 agent 按它执行适配。

## 两半之间怎么通信

宿主半边在 `ctx.get('webServer')` 上注册两个路由（`GET …/doctor`、`POST …/delete`），浏览器半边用同源 `fetch` 调用。这里没有使用 Harness 自带的 `ctx.remote`，因为它需要生成的 Typert 产物，而本插件刻意不带构建步骤。请求必须带自定义请求头，理由见"安全设计"。

## 目录结构

```
package.json                 插件清单：dsh.bundle.patch + dsh.client，无第三方依赖
cordis.patch.yml             该 bundle 贡献的 profile 配置层：插入一行 delete-conversation
src/index.js                 宿主半边：删除算法、HTTP 路由、doctor()、注册适配技能
src/client.js                浏览器半边：侧边栏菜单行（手写 lazy-CJS bundle，无构建）
skill/dsh-plugin-delete-conversation/SKILL.md  升级后的适配手册
compat/expected-surface.json 依赖面契约记录
test/delete-conversation.test.mjs  零依赖测试
tools/verify-deleted.mjs     磁盘核查：快照 / diff / 按标题或 id 查
tools/verify-live.ps1        对着运行中的界面做联调验证
tools/check-readme-paths.mjs 校验本文档提到的每个相对路径都真实存在
tools/pack-plugin.py         打 release 产物（tgz + zip），并解包自检
LICENSE                      MIT
```

## 版本规则

采用语义化版本，插件版本与 Harness 版本无关。功能变更、缺陷修复，以及**适配新版本 Harness** 都递增一次；适配时同时更新 `compat/expected-surface.json` 里的 `adaptedFor` 与插件版本号。

## 许可

MIT，见 [LICENSE](LICENSE)。

## 说明与限制

- **仍被内存持有的会话需要重启 Harness**：如果被删除的会话是在本次 Harness 运行期间打开过的，它还会留在进程内存里，界面会继续把它显示在"未分组"，而此时磁盘上的日志、缓存与归属已经删除。第三方插件没有销毁其它宿主会话的权限，doctor 与删除响应里的 `stillInMemory` 会明确报告这种情况。
- **附件不回收**，理由见"删除范围"。
- **删除当前正在查看的会话**后，会话视图会短暂停留在一个已不存在的会话上，切换会话或刷新后恢复。
- **会话 id 的校验**为 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`；日志目录只在 `<sessionsRoot>/<一层子目录>/<id>/` 之内删除。
- **宿主半边用原生 `node:fs` 删除日志**（`ctx.fs` 没有删除能力），因此这一步不经过 Harness 的文件沙箱。
- **浏览器半边没有构建步骤**：手写 bundle 使用 Harness 自带的菜单行组件与垃圾桶图标；若将来 Harness 改变 bundle 的加载约定，需要改为真正的构建产物。
