# 开发

**中文** | [English](DEVELOPMENT.md)

`dsh-sticky-notes-desktop` 的工程笔记：它是怎么搭起来的、给模型的契约是什么、测试怎么跑。
面向用户的文档在 [README.zh.md](README.zh.md)。

---

## 架构

DSH 的插件分两半，这个插件还额外带一个桌面助手：

```
┌─ DSH Electron 渲染进程（网页）───────────────────────┐
│  lib/client.bundle.js   便签面板 / 设置页 / 侧边栏入口 │
└───────────────┬─────────────────────────────────────┘
                │ 同源 fetch（带连接鉴权）
┌───────────────▼─ DSH Host（纯 Node）────────────────┐
│  lib/index.js     挂载、生命周期、sticky_notes_* 工具   │
│  host/store.js    便签与设置落盘、原子写、损坏隔离       │
│  host/bridge.js   助手生命周期 + 事件回写               │
│  host/routes.js   浏览器 JSON 接口                     │
│  host/tools.js    给模型的工具与文档                    │
└───────────────┬─────────────────────────────────────┘
                │ loopback TCP + NDJSON（带 token 握手）
┌───────────────▼─ 独立 Electron 助手（自带运行时）───────┐
│  electron/main.mjs      窗口/热键/弹窗/截图调度         │
│  electron/notes.mjs     置顶窗口、吸附、自动隐藏、唤出   │
│  electron/popup.mjs     鼠标处原生菜单                  │
│  electron/capture.mjs   整屏捕获 + 标注窗口             │
└─────────────────────────────────────────────────────┘
```

三个关键设计决定，都写在对应文件的注释里：

1. **为什么需要独立 Electron 运行时。** DSH 的 host 进程跑在 `ELECTRON_RUN_AS_NODE=1` 下，是纯
   Node —— 没有 `BrowserWindow`、没有 `screen`、没有 `globalShortcut`。想拿到真·置顶窗口，唯一
   的路是自己拉起一个 Electron。插件会优先复用 `dsh-orb` 已经下载好的运行时
   （`~/.dsh/dsh-orb/electron-runtime`），没有才自己下到 `~/.dsh/sticky-notes/electron-runtime`。

2. **为什么用 TCP 而不是 stdio。** 实测 Electron 主进程里 `process.stdin` **没有可用的 fd**：流
   报告 `readable: true`，但 `'end'` 立刻触发、一个字节都收不到。stdout 是好的，所以握手（端口 +
   token）走 stdout，业务走 loopback TCP。`dsh-orb` 同样绕开了 stdio。

3. **为什么助手锁按数据目录而不是全局。** `app.requestSingleInstanceLock()` 是按 Electron 二进制
   锁的，会让"另一个 profile 的助手"或"插件自己的测试"把用户的助手挡在门外并报
   `already-running`。锁必须锁在它保护的数据上，所以改成按数据目录加 `helper.lock`（记 pid，进程
   没了就回收）。

## 给模型的工具面

`lib/host/tools.js` 里放着 12 个工具、始终在场的系统提示段（`USAGE_GUIDE`）和 `sticky-notes`
技能。其中有**三个错了不报错**的约束，都是读 DSH 自己的实现确认的。

### `output.render` 必须返回 `ContentBlock[]`，不是字符串

注册时**不会**校验这一点 —— `snapshotProjection` 只要求返回值是无损 JSON。所以字符串能顺利通过
注册和投影，然后在某个对 `result.content` 调 `.some(…)` 的地方炸掉。

> 真正抛错的是 `@deepseek-ai/dsh-spill-policy` 的 `tools/post-execute` 监听器：
> `const content = decision.content ?? result.content; const hasImages = content.some(…)`。
> 它以 `{ prepend: true }` 注册、由 `dsh-base` 默认启用，**每一次**工具结果都会经过，而且位于
> 任何 `try` 之外 —— 所以它是在工具体**已经执行完并落盘之后**才抛的。正是这个顺序让症状极具
> 误导性：便签其实真的建出来了，而这次调用却被报成错误。
>
> DSH 其实自带一个报错信息写得很好的校验器 —— `dsh-cordis-host-runner` 的
> `assertRenderedContent`，它会说"必须返回一个 content blocks 数组"。但它只接在沙箱化的
> `harness.defineTool` 路径上，直接调 `ctx.tools.register` 的插件永远碰不到它。这就是这个 bug
> 一直静默的原因。

DSH 自己每个工具都返回 `[{ type: 'text', text }]`；这个插件也一样，而且共用的 `textOutput` 会把
返回的字符串强制转成这个形状，所以自定义 render 也没法再引入。已经是数组时**原样通过** —— DSH 支持
多块结果（文字 + 图片），强行转换会把多出来的块悄悄丢掉。

### 每个 object 节点都必须显式写 `additionalProperties`

`ctx.tools.register` 会对 `parameters` 和 `output.schema` 跑一遍 DSH 的 JSON Schema 子集校验。这个
子集比"合法 JSON Schema"更严：**每个** object 节点都要显式写 `additionalProperties: true/false`，
`oneOf` 不能与 `type` 同时出现，`$ref` / `allOf` / `pattern` / `format` / 数值上下界一律不接受。

违反会在"每个工具各自的 `try`"里抛出，于是**那一个工具就从模型的列表里悄悄消失了**。
`tools/check-tool-schemas.mjs` 把这条子集放在测试里守，而不是等生产环境发现。

### 技能的 `whenToUse` 根本不会送到模型那里

DSH 给模型的是一份只有 `name: description` 的目录，描述还会被截断到 500 字符；`whenToUse` 和
`path` 都不会渲染。所以"`description` 写它是什么、`whenToUse` 写什么时候用"的做法，等于给模型一
条它没有理由打开的条目 —— **触发词必须写在 `description` 里**。

### 让这一切曾经完全不可见的那个 bug

第一版只注册了**一个**叫 `sticky_notes` 的工具，用 `action` 枚举分派，写法是这样的：

```js
ctx.inject(['tools'], (toolCtx) => toolCtx.tools.register({ … }));
```

`inject` 回调拿到的 context **不会把服务挂成属性** —— 要用 `ctx.get(name)` 取。所以 `toolCtx.tools`
是 `undefined`，外层的 `try` 把这个 `TypeError` 变成一条没人看的 `log.warn`，于是插件**一个模型工具
都没注册上**。

没有任何东西报错。模型就是没有 `sticky_notes` 这个工具，于是每次"给我记一条"都只能靠 `pwsh` 和读
文件去凑 —— 这就是"又慢又不准"的真正原因。

修法就是 DSH 自己插件用的约定：在 `inject` 导出里声明 `tools`，然后用 `ctx.tools` 取。排查时实测：
在 host 侧新建一条便签并弹出窗口耗时 **130–155ms**，其余操作约 3ms —— **host 从来不是慢的那一环**。

## 测试

`npm test` 跑的是全部无需 DSH 实例的套件：

```bash
npm run build     # 把 lib/ui/*.js + lib/client.js 拼成 lib/client.bundle.js
npm test          # 跑全部无需 DSH 实例的套件
npm run check:readme    # 校验两份 README 的相对链接都指向真实文件
npm run check:schemas   # 校验工具 schema 符合 DSH 的子集
```

浏览器那一半必须是**单个自包含文件**（DSH 只服务一个文件，兄弟文件 `import` 会 404）。所以源码分在
`lib/ui/` 下、用 `globalThis.__dshSticky` 命名空间串起来，由 `tools/build-client.mjs` 原样拼接。
**改 `lib/client.js` 或 `lib/ui/*.js`，不要手改 bundle。**

| 测试 | 覆盖 |
|---|---|
| `tools/test-geometry.mjs` | 吸附/隐藏/唤出/落点几何：83 用例、65k+ 断言、含随机不变量 |
| `tools/test-package.mjs` | 包契约（入口、补丁、自包含 bundle、运行期资产都被 `files` 覆盖）+ `apply` 在恶劣 context 下不抛异常 |
| `tools/test-client-load.mjs` | 按 DSH 真实方式加载 bundle：槽位注册、组件可渲染、快捷键录制、颜色辅助函数，以及标签该带/不该带包名 |
| `tools/test-tool-registration.mjs` | **给模型的工具面**：`inject` 声明了 `tools`、12 个工具都带上 DSH 要求的 `output` schema 与 `render`、每个 `execute` 都返回无损 JSON、`textOutput` 会把字符串 render 归一成 content blocks、提示段与技能有实际内容。它的假 context 忠实于 Cordis |
| `tools/check-tool-schemas.mjs` | 每个 object 节点都有 `additionalProperties`、不出现被拒的关键字 |
| `tools/check-readme-links.mjs` | 两份 README 的相对链接都真实存在、互相链接、展示的图片都随包发布 |
| `tools/test-electron-helper.mjs` | 真 Electron：握手、建真窗口、吸附、自动收起、弹回、快捷键冲突如实上报（不自动换键）、快捷键建便签、整屏捕获、干净退出 |
| `tools/test-popup.mjs` | 弹窗行为：出现在鼠标处、鼠标移开自动消失、Escape 可关、消失后再按还能弹出、选「新建便签」真的建出便签 |
| `tools/test-popup-appearance.mjs` | 弹窗外观：2 行都渲染出来、正好 168×88 无溢出（透明窗口会把溢出内容直接裁掉） |
| `tools/test-alarm-schedule.mjs` | 闹钟排期：每天/工作日/指定时间各自何时该响、同分钟不重复响、错过要补响、`2026-02-30` 与非补零时间必须拒绝 |
| `tools/test-alarm-ring.mjs` | 闹钟真的响：真 Electron 弹窗可见、记账写入、关闭被登记、删除不留孤儿窗口、闹钟不混进便签 |
| `tools/test-shot-actions.mjs` | 截图三个按钮，在真实标注窗口里操作，含**便签落在框选位置**（不是左上角） |
| `tools/test-hide-modes.mjs` | 两种隐藏模式的真窗口行为：`offscreen` 把 260px 便签停到 `x=-259`、`tab` 收成 36×120，两者都能滑回 |
| `tools/test-note-appearance.mjs` | 真 Electron 渲染 3 种配色，断言文字色传到标题栏/正文，对比度 ≥ 4.5:1 |
| `tools/test-helper-service.mjs` | 未运行→启动→重启→停止→再启动的真实生命周期；"进程在但不应答"必须报无响应 |
| `tools/test-bridge.mjs` | Host 桥接集成：起助手、事件回写存储、模拟重启后恢复隐藏便签、干净释放 |

另有三个套件需要先起一个 DSH 实例，其中两个还需要一个开了 `--remote-debugging-port` 的 Chromium：

```bash
dsh --profile <临时profile> --port 0 --no-open   # 记下 stdout 里的 port 与 token
node tools/test-live.mjs <port> <token>
node tools/test-ui.mjs <port> <token> <cdpPort>
node tools/test-alarm-ui.mjs <port> <token> <cdpPort>
node tools/test-service-ui.mjs <port> <token> <cdpPort>
```

两个工具用于验证**已安装**的那一份（而不是本仓库）：

| 工具 | 用途 |
|---|---|
| `tools/verify-install.mjs <profile目录> <包名>` | 已安装的 bundle 能否解析与加载：包名、`dsh.bundle.patch`、补丁里的 `name`、`exports["./client"]`，以及真的 import 并跑 `apply`。**改名/重装后最先该跑的就是它** —— 这几种不一致都会表现成一句 `failed to import`，不告诉你是哪个字符串错了 |
| `tools/read-installed-name.mjs <profile目录> <包名>` | 已安装的 bundle 会显示成什么名字，从 `node_modules` 里那份浏览器 bundle 读出。`link:` 安装时它和仓库是同一份文件，`.tgz` 安装时不是 —— 发布形态要用它确认 |

`CONTRACT.md` 是模块间的冻结接口（含 TCP 协议与 IPC 通道表），改协议前先改它。

## 发布

这个包**还没发布到 npm**。要发布：

```bash
npm publish     # 在本目录执行，需要 npm 账号
```

之后别人就能用 `install_bundle("dsh-sticky-notes-desktop")` 一行装上。

几条相关事实，都是读 DSH 的插件管理器确认的：

- `dsh.bundle.patch` 是**唯一**必需的清单字段；`private: true` 不影响。
- `install_bundle` 接受绝对目录、绝对 `.tgz`、git 地址、或 registry 包名。**相对路径会被拒绝。**
- `files` 只对 `.tgz`／npm 安装有意义。`link:` 安装是软链接到源码目录，所以漏在 `files` 外的文件
  **本地照跑、别人装上就缺** —— `test-package.mjs` 会从代码推导运行期用到的资产并逐个核对 `files`，
  就是为了这个。
- 不带任何生命周期脚本，所以永远不需要 `approvedBuilds`。
- 没有声明任何 `@deepseek-ai/dsh-*` peer，所以安装时的兼容性检查没有东西可拒。
- 插件列表卡片的标题是 `locale/zh.json` 里的字面量，因为 DSH 在**任何插件代码运行之前**就读那个
  JSON。它是改名时唯一需要手改的字符串。

`docs/` 里有两张截图（`editor.png`、`panel.png`）已经不再被任何一份 README 引用，但依然会被发布 ——
因为 `files` 列的是整个目录。要去掉它们就得删文件本身。

## 许可

MIT
