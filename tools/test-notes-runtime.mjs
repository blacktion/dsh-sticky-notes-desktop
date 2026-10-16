/**
 * Actually run `NoteManager` against a stubbed Electron, to catch errors a syntax check cannot.
 *
 * ## Why
 *
 * A parameter rename in `geometry.js` left one branch reading the old name. `node --check` passed —
 * parsing does not check whether an identifier exists — so the mistake only appeared when the helper
 * started, where the `ReferenceError` surfaced as "the plugin failed to import" and DSH would not load.
 *
 * Static attempts did not work: grepping for `workArea` cannot tell a dangling variable from a
 * legitimate `display.workArea`, and a token-based checker drowned in false positives from method names.
 * The one reliable answer is to **execute the code**, which is what this does. Electron is replaced by a
 * stub through a resolve hook (`tools/electron-stub-loader.mjs`), so no window is created and no real
 * display is touched.
 *
 * Usage: node tools/test-notes-runtime.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/test-notes-runtime
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STUB_FILE = fileURLToPath(new URL('.electron-stub-source.mjs', import.meta.url));

/**
 * The stand-in for Electron.
 *
 * The display carries a bottom taskbar, so `bounds` and `workArea` genuinely differ. Without that
 * difference this whole class of bug is invisible — which is exactly how it reached the user.
 */
export const STUB_SOURCE = `
const displays = [
  { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 },
  { id: 2, bounds: { x: 1920, y: 816, width: 1280, height: 720 }, workArea: { x: 1920, y: 816, width: 1280, height: 680 }, scaleFactor: 1 },
];
const created = [];
class BrowserWindow {
  constructor(options) {
    this.options = options ?? {};
    this.destroyed = false;
    this.lastBounds = null;
    this.webContents = {
      send() {}, on() {}, once() {}, removeListener() {}, setWindowOpenHandler() {}, openDevTools() {},
      executeJavaScript: async () => undefined, id: created.length + 1, session: { webRequest: { on() {} } },
    };
    created.push(this);
  }
  getBounds() { return this.lastBounds ?? { x: 500, y: 400, width: 260, height: 200 }; }
  setBounds(next) { this.lastBounds = next; }
  getPosition() { return [500, 400]; }
  setPosition(x, y) { this.lastPosition = [x, y]; }
  setMinimumSize() {} setResizable() {} setVisibleOnAllWorkspaces() {}
  moveTop() { (this.moveTopCalls ??= []).push(Date.now()); }
  setAlwaysOnTop(flag, level) { (this.alwaysOnTopCalls ??= []).push([flag, level]); }
  setIgnoreMouseEvents() {} setSkipTaskbar() {} setOpacity() {} setBackgroundColor() {}
  setHasShadow() {} setFocusable() {}
  isDestroyed() { return this.destroyed; }
  isVisible() { return true; } isMinimized() { return false; }
  show() {} showInactive() {} hide() {} focus() {} close() { this.destroyed = true; } destroy() { this.destroyed = true; }
  loadFile() { return Promise.resolve(); } loadURL() { return Promise.resolve(); }
  on() {} once() {} removeListener() {}
  static getAllWindows() { return created; }
  static fromWebContents() { return null; }
}
const screen = {
  getAllDisplays: () => displays,
  getPrimaryDisplay: () => displays[0],
  getDisplayNearestPoint: () => displays[0],
  getDisplayMatching: () => displays[0],
  getCursorScreenPoint: () => ({ x: 960, y: 540 }),
  on() {}, removeListener() {},
};
export { BrowserWindow, screen };
export const ipcMain = { handle() {}, on() {}, removeHandler() {}, once() {} };
export const app = {
  on() {}, once() {}, whenReady: () => Promise.resolve(), quit() {},
  commandLine: { appendSwitch() {} }, getPath: () => '/tmp', getAppPath: () => '/tmp',
};
export const shell = { openPath: async () => '' };
export const nativeImage = { createFromPath: () => ({ isEmpty: () => true, resize: () => ({ isEmpty: () => true }) }) };
export const dialog = { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) };
export const clipboard = { writeImage() {}, writeText() {} };
export default { BrowserWindow, screen, ipcMain, app };
`;

writeFileSync(STUB_FILE, STUB_SOURCE, 'utf8');
register(new URL('./electron-stub-loader.mjs', import.meta.url), import.meta.url);

let NoteManager;
try {
  ({ NoteManager } = await import('../electron/notes.mjs'));
} finally {
  rmSync(STUB_FILE, { force: true });
}

const failures = [];
const check = (label, fn) => {
  try {
    fn();
    console.log(`  [通过] ${label}`);
  } catch (error) {
    console.error(`  [失败] ${label}`);
    console.error(`         ${error instanceof Error ? error.stack : String(error)}`);
    failures.push(label);
  }
};

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const settings = {
  hotkey: '', backgroundColor: '#000000', opacity: 0.8, textColor: '#ffffff', fontSize: 14,
  snapDistance: 12, autoHideDelayMs: 900, revealDelayMs: 180, hideMode: 'offscreen',
  autoStartHelper: true,
};

const make = () => new NoteManager({ settings, emit: () => {}, logger });

console.log('=== NoteManager 能被构造出来 ===');
let manager = null;
check('构造 NoteManager 不抛异常', () => {
  manager = make();
  assert.ok(manager !== null);
});

console.log('\n=== 快捷键新建便签的落点（screenRectOf 路径） ===');
let note = null;
check('createTextNote 不抛异常并返回便签', () => {
  note = manager.createTextNote({ x: 1700, y: 1000 });
  assert.ok(note !== null && typeof note === 'object', '必须返回便签对象');
  assert.ok(Number.isFinite(note.x) && Number.isFinite(note.y), `落点无效：${note.x},${note.y}`);
});

console.log('\n=== 便签窗口的显示 / 隐藏（hiddenBounds 与 revealZone 路径） ===');
check('setHidden 不抛异常（回归：曾有分支引用未定义变量）', () => {
  if (note === null) return;
  manager.setHidden(note.id, true, 'bottom');
  manager.setHidden(note.id, false);
  manager.setHidden(note.id, true, 'top');
  manager.setHidden(note.id, false);
});

console.log('\n=== 把便签放到下边缘并吸附（snapToEdge 的边界判定） ===');
check('setBoundsFromRenderer 在下边缘不抛异常', () => {
  if (note === null) return;
  manager.setBoundsFromRenderer(note.id, { x: 500, y: 876, width: 260, height: 200 });
});

console.log('\n=== 两种隐藏模式 × 四条边都要能跑（tab 分支就是当初出错的地方） ===');
for (const hideMode of ['offscreen', 'tab']) {
  check(`hideMode=${hideMode}：四条边隐藏/显示都不抛异常`, () => {
    const m = new NoteManager({ settings: { ...settings, hideMode }, emit: () => {}, logger });
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      const n = m.createTextNote({ x: 600, y: 500 });
      m.setHidden(n.id, true, edge);
      m.setHidden(n.id, false);
    }
  });
}

console.log('\n=== 从磁盘恢复（含隐藏态）：走 create() 的 screenRect 路径 ===');
check('create() 恢复普通便签不抛异常', () => {
  const m = new NoteManager({ settings, emit: () => {}, logger });
  const n = m.create({ id: 'restore-plain', kind: 'text', text: 'hi', title: '', x: 500, y: 1060, width: 260, height: 200 });
  assert.ok(n !== null, '必须返回便签状态');
});

check('create() 恢复【隐藏态】便签不抛异常 —— 正是当初崩溃的那一行', () => {
  for (const hideMode of ['offscreen', 'tab']) {
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      const m = new NoteManager({ settings: { ...settings, hideMode }, emit: () => {}, logger });
      const n = m.create(
        {
          id: `restore-${hideMode}-${edge}`,
          kind: 'text',
          text: 'x',
          title: '',
          x: 500,
          y: 880,
          width: 260,
          height: 200,
          hidden: true,
          edge,
        },
        { announce: false },
      );
      assert.ok(n !== null, `${hideMode}/${edge} 恢复失败`);
    }
  }
});

console.log('\n=== 物理屏幕边界（便签可遮挡任务栏） ===');
check('新建便签允许落在物理屏幕底边之内，不被夹回任务栏上方', () => {
  const low = manager.createTextNote({ x: 900, y: 1070 });
  const bottom = low.y + low.height;
  assert.ok(bottom <= 1080, `底部 ${bottom} 超出物理屏幕 1080`);
  assert.ok(bottom > 1040, `底部 ${bottom} 应能越过工作区底边 1040，否则等于没改`);
});

// ---------------------------------------------------------------------------------------------
// 「保留」的便签可以往左右和下挂出（至少留 40px），普通便签不行。
//
// The geometry itself is unit-tested in `test-geometry.mjs` (group 11). What this adds is that the
// *manager* routes to it: both the drag path and the gesture-commit path have to agree, and if only one
// did, a kept-out note would jump back to a flush edge the moment a drag was committed — a bug no
// geometry test can see.
// ---------------------------------------------------------------------------------------------
console.log('\n=== 保留的便签可以挂出屏幕边缘 ===');
{
  const m = new NoteManager({ settings, emit: () => {}, logger });
  const n = m.createTextNote({ x: 900, y: 500 });

  // Derived from the note's own size rather than hard-coded. The first version of this test spelled
  // `1700` and `260` literally, so widening the default note silently turned a correct overhang into a
  // failed assertion — the arithmetic moved and the test did not.
  const W = n.width;
  const H = n.height;
  const SCREEN_W = 1920;
  const SCREEN_H = 1080;
  // A position that sits `overhang` px outside the right edge once the note is W wide.
  const nearRightEdge = SCREEN_W - W + 40;

  // Without the flag the flush clamp refuses any overhang.
  m.setBoundsFromRenderer(n.id, { x: nearRightEdge, y: 400, width: W, height: H });
  const flush = m.getNote(n.id);
  check('未保留：拖过右边缘会被夹回，不挂出', () => {
    assert.ok(flush.x + flush.width <= SCREEN_W, `右侧不应越界，实际 ${flush.x + flush.width}`);
  });

  m.setPinned(n.id, true);
  m.setBoundsFromRenderer(n.id, { x: nearRightEdge, y: 400, width: W, height: H });
  const hung = m.getNote(n.id);
  check('已保留：向右可以挂出 40px', () => {
    assert.equal(hung.x, nearRightEdge, `x 应保持 ${nearRightEdge}，实际 ${hung.x}`);
    assert.equal(hung.x + hung.width - SCREEN_W, 40, `右侧应挂出 40px，实际 ${hung.x + hung.width - SCREEN_W}`);
  });

  check('已保留：向下可以挂出', () => {
    const nearBottom = SCREEN_H - H + 120;
    m.setBoundsFromRenderer(n.id, { x: 800, y: nearBottom, width: W, height: H });
    const low = m.getNote(n.id);
    assert.equal(low.y, nearBottom, `y 应保持 ${nearBottom}，实际 ${low.y}`);
    assert.equal(low.y + low.height - SCREEN_H, 120, `下方应挂出 120px，实际 ${low.y + low.height - SCREEN_H}`);
  });

  check('已保留：向上仍不许挂出（标题栏要留在屏幕内）', () => {
    m.setBoundsFromRenderer(n.id, { x: 800, y: -50, width: W, height: H });
    assert.equal(m.getNote(n.id).y, 0, '上边缘必须贴齐 0');
  });

  check('已保留：拖到极远仍留有 40px 在屏内（抓得回来）', () => {
    m.setBoundsFromRenderer(n.id, { x: 99999, y: 99999, width: W, height: H });
    const far = m.getNote(n.id);
    assert.ok(SCREEN_W - far.x >= 40, `屏内应留够 40px，实际 ${SCREEN_W - far.x}`);
    assert.ok(far.x < SCREEN_W, '必须仍有一部分在屏内');
  });
}

// ---------------------------------------------------------------------------------------------
// 弹出路径必须重新声明置顶。
// ---------------------------------------------------------------------------------------------
console.log('\n=== 弹出路径重新声明置顶（否则会被画在任务栏下面） ===');
{
  const note = manager.createTextNote({ x: 600, y: 500 });
  const win = manager.windowFor(note.id);
  manager.setHidden(note.id, true, 'bottom');

  const before = (win.alwaysOnTopCalls ?? []).length;
  manager.setHidden(note.id, false);
  const after = (win.alwaysOnTopCalls ?? []).slice(before);

  check('弹出时显式置前（否则会画在任务栏下面）', () => {
    assert.ok((win.moveTopCalls ?? []).length > 0, '弹出路径必须调用 moveTop 把便签放到最前');
  });

  check('弹出时以 floating 层级重新声明置顶', () => {
    assert.ok(after.length > 0, '弹出路径必须调用 setAlwaysOnTop');
    const last = after[after.length - 1];
    assert.equal(last[0], true, `必须声明为置顶，实际 ${JSON.stringify(last)}`);
    assert.equal(last[1], 'floating', `必须使用 floating 层级，实际 ${JSON.stringify(last)}`);
  });
}

console.log(`\n${'─'.repeat(64)}`);
if (failures.length === 0) {
  console.log('NoteManager 运行期检查：全部通过 ✅（真的跑了构造/新建/隐藏/显示/吸附，两种隐藏模式）');
  process.exit(0);
}
console.error(`NoteManager 运行期检查：${failures.length} 项失败 ❌`);
for (const f of failures) console.error(`  - ${f}`);
process.exit(1);
