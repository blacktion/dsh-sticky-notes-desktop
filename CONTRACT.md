# dsh-sticky-notes — 冻结的模块契约（v1）

本文件是**并行开发的唯一接口真相**。任何模块都必须严格遵守这里的形状；
不要改协议，需要变更时先改本文件。

---

## 0. 运行时事实（已实测，勿再假设）

| 事实 | 含义 |
|---|---|
| DSH host 进程 = 纯 Node | 真实命令行 `DeepSeek Harness.exe --expose-internals ...dsh-desktop-host\lib\index.js`，环境含 `ELECTRON_RUN_AS_NODE=1`。**没有 `BrowserWindow` / `screen` / `globalShortcut`。** |
| client 半 = Electron 渲染进程内的 web bundle | 经 `window.__ModuleLoader__.load({ id, factory })` 加载，`id` 必须等于包名。`factory(require)` 里只有 `react` 可解析。 |
| client 内建 | `ctx`、`React`、`host`、`styles`、`console`。可用 `window`/`document`（它就是网页）。 |
| Electron 运行时已存在于本机 | `~/.dsh/dsh-orb/electron-runtime/electron.exe`，版本 44.0.0，已验证。**不要重复下载。** |
| DSH 版本 | `0.2.0-rc.2`（Electron 44）。 |

**置顶窗口只能由我们自己的 Electron 助手进程创建。** host 通过 stdio NDJSON 驱动它。

---

## 1. 文件布局

```
dsh-sticky-notes/
  package.json
  cordis.patch.yml
  lib/
    index.js            host 入口（已由主控编写）
    client.js           client 入口（子代理 C）
    host/
      runtime.js        Electron 运行时发现 + NDJSON 客户端（已写好，勿改）
      store.js          持久化（已写好，勿改）
      rpc.js            host↔electron 高层桥（主控）
      routes.js         web 路由（主控）
      geometry.js       吸附/隐藏几何计算 —— 纯函数（子代理 D）
    ui/
      panel.js          便签面板（子代理 C）
      settings.js       设置页（子代理 C）
    shared/
      protocol.js       常量（已写好，勿改）
  electron/
    package.json        { "main": "main.cjs" }
    main.cjs            Electron 主进程（主控）
    preload-note.cjs    便签窗口 preload（子代理 A）
    preload-shot.cjs    截图选区/标注窗口 preload（子代理 B）
    note.html           便签窗口页面（子代理 A）
    note.css            便签窗口样式（子代理 A）
    shot.html           截图标注页面（子代理 B）
    shot.css            截图标注样式（子代理 B）
```

**`lib/client.js` 必须是自包含 bundle。**
它可以 `require('react')`，但**不能** `import` 兄弟文件 —— 浏览器端拿不到。
构建方式：`node tools/build-client.mjs` 把 `lib/client.js` + `lib/ui/*.js` + `lib/shared/protocol.js`
内联成一个 bundle 输出到 `lib/client.bundle.js`，并由 `package.json` 的
`exports["./client"]` 指向它。请始终编辑 `lib/client.js`，不要手改 bundle。

---

## 2. host ↔ Electron 助手 协议（**loopback TCP + NDJSON**）

> **实测结论：不能用 stdio。** Electron 主进程里 `process.stdin` 没有可用的 fd——
> 流报告 `readable: true`，但 `'end'` 立刻触发、一个字节都收不到（已用最小探针复现）。
> stdout **可用**，所以握手走 stdout，业务走 socket。
> `dsh-orb` 同样绕开了 stdio。

**握手**（子进程启动后立刻，stdout 一行，仅一次）
```json
{"ready":true,"port":52341,"token":"<48位十六进制>","pid":12345}
```
失败时：`{"ready":false,"reason":"already-running"}`。

**连接**（host → 127.0.0.1:port，第一条帧必须是握手）
```json
{"hello":true,"token":"<同上>"}
```
回执（同时也是**就绪报告**，所以 host 不依赖推送事件）：
```json
{"ok":true,"result":{"authorised":true,"ready":{"version":"44.0.0","displays":2,"pid":12345,"platform":"win32"}}}
```
令牌不匹配 → `{"ok":false,"error":"unauthorised"}` 并断开。

**请求**（host → 助手）
```json
{ "id": 12, "method": "note.create", "params": { } }
```

**响应**（助手 → host）
```json
{ "id": 12, "ok": true,  "result": { } }
{ "id": 12, "ok": false, "error": "人类可读的原因" }
```

**事件**（助手 → host，无 `id`；仅握手完成后的推送可靠）
```json
{ "event": "note.moved",  "data": { "id": "n_1", "x": 10, "y": 20, "edge": "right", "hidden": true } }
{ "event": "note.hidden", "data": { "id": "n_1", "hidden": true, "edge": "right" } }
{ "event": "note.updated","data": { "id": "n_1", "patch": { "text": "…" } } }
{ "event": "note.closed", "data": { "id": "n_1", "deleted": true } }
{ "event": "shot.saved",  "data": { "path": "C:\\...\\a.png", "width": 800, "height": 600 } }
{ "event": "shot.cancelled", "data": { } }
{ "event": "helper.ready", "data": { "version": "44.0.0", "displays": 2 } }
{ "event": "helper.error", "data": { "message": "..." } }
```

### 方法表

| method | params | result | 说明 |
|---|---|---|---|
| `helper.ping` | `{}` | `{ ok: true, version }` | 存活探测 |
| `displays.list` | `{}` | `{ displays: DisplayInfo[] }` | 供吸附计算 |
| `note.create` | `{ note: Note, settings: Settings }` | `{ id }` | 建置顶窗口 |
| `note.update` | `{ id, patch: Partial<Note> }` | `{ ok: true }` | 改内容/外观/位置 |
| `note.remove` | `{ id }` | `{ ok: true }` | 关窗（不删数据） |
| `note.focus` | `{ id }` | `{ ok: true }` | 显示并聚焦 |
| `note.setHidden` | `{ id, hidden, edge? }` | `{ ok: true }` | 强制隐藏/显示 |
| `note.list` | `{}` | `{ ids: string[] }` | 当前存活窗口 |
| `popup.show` | `{ x, y, items }` | `{ choice }` | 鼠标处弹出菜单，`choice` ∈ `new-note`/`shot`/`null` |
| `shot.begin` | `{ mode, settings }` | `{ path, width, height }` 或 `{ cancelled: true }` | 全屏捕获→框选→标注→保存 PNG |
| `settings.apply` | `{ settings }` | `{ ok: true }` | 热键等全局设置同步 |
| `helper.quit` | `{}` | `{ ok: true }` | 退出助手 |

### 类型

```ts
type Note = {
  id: string
  kind: 'text' | 'shot'
  title: string
  text: string          // kind==='text' 时的正文
  x: number; y: number  // 窗口左上角，屏幕坐标
  width: number; height: number
  hidden: boolean       // 是否已吸附隐藏
  edge: 'left'|'right'|'top'|'bottom'|null
  snapDir: string|null
  color: string         // 背景色 #rrggbb
  opacity: number       // 0.2–1
  textColor: string
  fontSize: number
  alwaysOnTop: boolean
  image: string|null    // kind==='shot' 时图片绝对路径
  createdAt: string; updatedAt: string
}

type Settings = {
  hotkey: string                 // Electron accelerator，默认 'CommandOrControl+Alt+S'
  backgroundColor: string        // 默认 '#000000'
  opacity: number                // 默认 0.8
  textColor: string              // 默认 '#f5f5f5'（黑底需要浅色文字）
  fontSize: number
  snapDistance: number
  hideMode: 'offscreen'|'tab'   // 默认 'offscreen'：整块移出屏幕外，只留 1px
  autoHideDelayMs: number
  revealDelayMs: number
  autoStartHelper: boolean
  exportDir: string
}

type DisplayInfo = { id: number, bounds: {x,y,width,height}, workArea: {x,y,width,height}, scaleFactor: number }
```

---

## 3. host web 路由契约（client 半消费）

前缀 `/plugins/dsh-sticky-notes`，**全部**经 `authenticatedWebRoutes` 包装
（`lib/host/web.js` 提供 `authenticatedWebRoutes` / `readJsonBody` / `sendJson`）。
client 侧统一用 `fetch(path, { credentials: 'same-origin' })`。

| 方法 | 路径 | body / query | 返回 |
|---|---|---|---|
| GET | `/state` | — | `{ notes: Note[], settings: Settings, helper: { running, electronPath, error } }` |
| POST | `/notes` | `Partial<Note>` | `{ note }` |
| PATCH | `/notes` | `{ id, patch }` | `{ note }` |
| DELETE | `/notes?id=` | — | `{ removed: boolean, notes }` |
| POST | `/notes/open` | `{ id }` | `{ ok }` — 建/显示置顶窗口 |
| POST | `/notes/hide` | `{ id, hidden }` | `{ ok }` |
| GET | `/settings` | — | `{ settings }` |
| PATCH | `/settings` | `Partial<Settings>` | `{ settings }` |
| POST | `/capture` | `{ mode: 'shot' }` | `{ note?, cancelled? }` — 截图存为便签 |
| POST | `/popup` | `{ x, y }` | `{ choice }` — 鼠标处菜单 |
| GET | `/helper` | — | `{ running, electronPath, source, error }` |
| POST | `/helper/start` | — | `{ running }` |
| POST | `/helper/stop` | — | `{ running }` |
| GET | `/image?id=` | — | PNG 二进制（`Content-Type: image/png`） |

---

## 4. client 槽位注册（必须照抄这个形状）

必须用 `ctx.slots.inject(slotName, () => ctx.slots.register({...}, Component))`
并且**整体包在 `ctx.effect(...)` 里**，否则 HMR/卸载不会释放。

```js
ctx.effect(
  () => ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => t('title') }, IconComponent)),
  'sticky-notes: sidebar entry',
);
```

已确认存在的槽位（实测自 live Inspect）：

- `main`（keyed，按 sidebar entry id 派发）— 便签整页面板
- `sidebar.panellist`（list）— 左侧栏图标入口，`id` 即 `main` 的 key
- `settings.section`（list）— **设置界面新增一页** → 「便签设置」
- `shell.overlay`（list）— 全帧浮层，可放 toast

设置页注册：
```js
ctx.slots.register({ name: 'settings.section', id: 'sticky-notes', order: 60, label: () => '便签设置', locale: NS }, SettingsPage)
```

locale：`inject = ['slots', 'locale']`；`ctx.locale.register(NS, { zh: {...}, en: {...} })`。

---

## 5. Electron 主进程 ↔ 渲染窗口 IPC 契约（冻结）

窗口一律 `contextIsolation: true` + `nodeIntegration: false` + preload。preload 用
`contextBridge.exposeInMainWorld('sticky', {...})` 暴露下面这些方法。
**主进程侧通道名固定，不要改名。**

### 便签窗口 —— preload 暴露为 `window.sticky`（`electron/preload-note.cjs`）

| 通道 | 方向 | 载荷 | 回执 |
|---|---|---|---|
| `note:init` | renderer→main | `null` | `{ note, settings }` |
| `note:save` | renderer→main | `{ text, title }` | `{ ok: true }` |
| `note:update` | renderer→main | `Partial<Note>` | `{ ok: true }` |
| `note:close` | renderer→main | `null` | `{ ok: true }`（关窗，保留数据） |
| `note:delete` | renderer→main | `null` | `{ ok: true }`（关窗并删数据） |
| `note:hide` | renderer→main | `{ hidden: boolean }` | `{ ok: true }` |
| `note:pickColor` | renderer→main | `null` | `{ color: string\|null }` |
| `note:exportImage` | renderer→main | `null` | `{ path: string\|null }`（截图便签另存 PNG） |
| `note:state` | main→renderer | `{ note, settings }` | 主进程主动推送状态变化（如外部改了颜色） |
| `note:commitText` | renderer→main | `{ text }` | 防抖自动保存，main 转 `note.moved` 风格事件给 host |

拖动/缩放**由 CSS `-webkit-app-region: drag` 与 `resize: both` 之外的方式实现**：
本窗口是 `frame: false` 的透明窗口，请用 **DOM 指针事件算出新 bounds，然后调
`window.sticky.setBounds({x,y})` / `setSize({width,height})`**（这两个也请一并
在 preload 暴露，通道 `note:setBounds` / `note:setSize`）。

> 吸附、隐藏、鼠标靠近显示**全部由主进程负责**（它才知道窗口真实位置和全局光标）。
> 渲染窗口只需：报告「用户开始拖动 / 结束拖动 / 开始缩放 / 结束缩放」
> （通道 `note:dragState`，载荷 `{ dragging: boolean, resizing: boolean }`）。

### 截图选区/标注窗口 —— preload 暴露为 `window.shot`（`electron/preload-shot.cjs`）

| 通道 | 方向 | 载荷 | 回执 |
|---|---|---|---|
| `shot:init` | renderer→main | `null` | `{ dataUrl, width, height, scaleFactor, mode }` |
| `shot:commit` | renderer→main | `{ dataUrl, width, height, target }` | `{ path, width, height }`；`target` ∈ `'file'`(导出PNG) / `'note'`(存为便签) / `'both'` |
| `shot:cancel` | renderer→main | `null` | `{ ok: true }` |
| `shot:copy` | renderer→main | `{ dataUrl }` | `{ ok: true }` |

`dataUrl` 是 `data:image/png;base64,...`。

---

## 6. 崩溃安全铁律（违反即返工）

1. `apply()` **绝不抛异常**。整体 try/catch，每个可选子系统各自 try/catch，
   失败降级为「已加载但该功能不可用」，并 `console.warn`。
2. 可选服务一律 `ctx.get('name')` + `undefined` 判断，**不要** `ctx.name`。
3. Electron 助手不可用（没装/下载失败/崩了）时，**所有其他功能仍须可用**：
   便签列表能看能编辑、设置能改，只是无法弹出置顶窗口。UI 必须显示降级原因。
4. 不要新增运行时 npm 依赖。`react` 由 DSH 提供；Node 内置模块随便用。
5. 所有对子进程/文件/网络的调用都要有超时或错误捕获。
6. 不要动 `resources/app.asar` 里的任何东西，不要改 DSH 安装目录。
