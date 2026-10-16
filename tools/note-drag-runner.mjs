/**
 * Drive a real note window and check that the first drag after typing moves it.
 *
 * ## The report
 *
 * Type into a note, then drag it by the title bar. The first press-and-move did nothing; the note only
 * started moving on a second attempt, because the first one had to spend itself clearing the text
 * focus. The question was whether that is fixable.
 *
 * ## What was actually wrong
 *
 * `window`'s `blur` handler ended the pointer gesture unconditionally. That guard exists for a real
 * reason — if the window loses focus, pointer events can stop arriving and the note would be stranded
 * in "dragging" state — but it was too broad. Pressing the title bar while the body still holds focus
 * moves focus out of the input, and the window can report a blur as part of that hand-off, so the
 * gesture was torn down before the pointer had travelled far enough to count as a drag.
 *
 * The pointer's own button state settles it: a blur with the primary button still held is a focus
 * change, not a released pointer. Focus is also no longer left to the browser's default action — it is
 * dropped up front, while starting a gesture, so the focus change has already finished when the drag
 * begins and cannot race it.
 *
 * ## Two things this harness has to get right, both learned the hard way
 *
 *  - **It writes nothing to stdout.** An earlier version used `console.log` and ran under a parent
 *    whose pipe closed early; the write raised `EPIPE` *inside the Electron main process*, which
 *    answers that with a modal crash dialog and hangs. All output is collected in memory and written
 *    to a file at the end, which the wrapper then reads.
 *  - **It uses synthetic `PointerEvent`s, not `sendInputEvent`.** `sendInputEvent` does not populate
 *    `screenX`/`screenY` (they arrive as 0), and the component derives its drag delta from screen
 *    coordinates, so every move measured as zero and a working component looked broken. Synthetic
 *    events carry real screen coordinates, and their default action still performs the browser's own
 *    focus handling, which is part of what is under test.
 *
 * Usage: electron tools/note-drag-runner.mjs <resultFile>
 *
 * @module dsh-sticky-notes-desktop/tools/note-drag-runner
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = join(HERE, '..', 'electron');
const RESULT_FILE = process.argv[2] ?? join(HERE, '.note-drag-result.json');

const WIN_X = 400;
const WIN_Y = 300;
const WIDTH = 280;
const HEIGHT = 220;

/** Collected in memory; never written to stdout (see the note above about EPIPE). */
const lines = [];
const failures = [];
const log = (text = '') => lines.push(text);
const check = (label, ok, detail = '') => {
  log(`  ${ok ? '[通过]' : '[失败]'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures.push(label);
};

/** Everything the page reported, and every position it asked for. */
const events = [];
const bounds = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function installStub() {
  ipcMain.handle('note:init', () => ({
    id: 'test-note',
    kind: 'text',
    title: '',
    text: '',
    color: '#000000',
    opacity: 0.8,
    textColor: '#f5f5f5',
    fontSize: 14,
    pinned: false,
    hidden: false,
    bounds: { x: WIN_X, y: WIN_Y, width: WIDTH, height: HEIGHT },
  }));
  ipcMain.handle('note:setBounds', (_event, payload) => {
    bounds.push({ x: payload.x, y: payload.y });
    return { ok: true };
  });
  for (const channel of [
    'note:save',
    'note:update',
    'note:commitText',
    'note:setPinned',
    'note:setSize',
    'note:exportImage',
    'note:close',
    'note:hide',
    'note:delete',
  ]) {
    ipcMain.handle(channel, () => ({ ok: true }));
  }
  ipcMain.on('note:dragState', (_event, payload) => {
    events.push({ dragging: payload.dragging === true, resizing: payload.resizing === true });
  });
}

/**
 * Write the verdict and quit.
 *
 * Written before `app.exit` so the result survives even if teardown is interrupted, and written to a
 * file rather than a stream so a closed pipe on the parent side cannot throw in here.
 */
function finish(code) {
  const summary =
    code === 0
      ? '便签拖动测试：全部通过 ✅（输入焦点不影响第一次拖动）'
      : `便签拖动测试：${failures.length} 项失败 ❌`;
  log('');
  log('─'.repeat(64));
  log(summary);
  for (const f of failures) log(`  - ${f}`);
  try {
    writeFileSync(RESULT_FILE, `${JSON.stringify({ code, lines, failures }, null, 2)}\n`, 'utf8');
  } catch {
    /* nothing more can be done */
  }
  app.exit(code);
}

app.commandLine.appendSwitch('disable-gpu-compositing-cache');

app.whenReady().then(async () => {
  try {
    installStub();

    const win = new BrowserWindow({
      x: WIN_X,
      y: WIN_Y,
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      transparent: true,
      hasShadow: false,
      show: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(ELECTRON_DIR, 'preload-note.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    await win.loadFile(join(ELECTRON_DIR, 'note.html'));
    await sleep(900);

    /**
     * A point on the title bar that is neither a button nor the resize grip.
     *
     * Two ways to get this wrong, both of which make a working component look broken: the action
     * buttons sit at the right end and pressing one is ignored by design, and the grip is not inside
     * `#titlebar`, so it also reports as the bar while routing presses to the resize handler.
     */
    const dragPoint = await win.webContents.executeJavaScript(`(() => {
      const bar = document.getElementById('titlebar');
      const barRect = bar.getBoundingClientRect();
      const y = Math.round(barRect.y + barRect.height / 2);
      const inputRect = (() => { const el = document.getElementById('title-input'); return el ? el.getBoundingClientRect() : null; })();
      const buttons = [...document.querySelectorAll('#titlebar button')].map((b) => b.getBoundingClientRect());
      const gripRect = (() => { const el = document.getElementById('grip'); return el ? el.getBoundingClientRect() : null; })();
      const blocked = (x, rx) => (rx === null || rx === undefined ? false : x >= rx.x - 2 && x <= rx.x + rx.width + 2);
      const overlapsAny = (x) => blocked(x, inputRect) || blocked(x, gripRect) || buttons.some((r) => blocked(x, r));
      for (let x = Math.round(barRect.x + barRect.width - 6); x > barRect.x + 1; x -= 1) {
        if (overlapsAny(x)) continue;
        const el = document.elementFromPoint(x, y);
        if (el === null || el.closest('#titlebar') === null) continue;
        if (el.closest('button') !== null) continue;
        return { x, y };
      }
      return null;
    })()`);

    if (dragPoint === null) {
      log('找不到标题栏上非按钮、非缩放手柄的拖动点 —— 无法进行测试');
      finish(3);
      return;
    }
    const dragX = dragPoint.x;
    const dragY = dragPoint.y;
    log(`拖动起点: (${dragX}, ${dragY})`);

    const focusedNow = () => win.webContents.executeJavaScript('document.activeElement ? document.activeElement.id : null');
    const blurAll = () =>
      win.webContents.executeJavaScript('if (document.activeElement) document.activeElement.blur(); true');

    /** Dispatch one pointer event with real screen coordinates. */
    const pointer = async (type, clientX, clientY, buttons) => {
      await win.webContents.executeJavaScript(`(() => {
        const target = document.elementFromPoint(${clientX}, ${clientY}) || document.body;
        target.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
          bubbles: true, cancelable: true, composed: true,
          pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: ${buttons},
          clientX: ${clientX}, clientY: ${clientY},
          screenX: ${WIN_X + clientX}, screenY: ${WIN_Y + clientY},
        }));
        return true;
      })()`);
      await sleep(30);
    };

    /** Press on the title bar and glide, so the pointer crosses the drag threshold. */
    const dragTitlebar = async (dx, dy, steps = 6) => {
      await pointer('pointerdown', dragX, dragY, 1);
      for (let i = 1; i <= steps; i += 1) {
        await pointer('pointermove', dragX + Math.round((dx * i) / steps), dragY + Math.round((dy * i) / steps), 1);
      }
      await sleep(120);
      await pointer('pointerup', dragX + dx, dragY + dy, 0);
      await sleep(140);
    };

    // -------------------------------------------------------------------------------------------
    // The reported scenario.
    // -------------------------------------------------------------------------------------------
    log('=== 场景：先在正文里打字，再拖标题栏 ===');
    await win.webContents.executeJavaScript(`(() => {
      const editor = document.getElementById('editor');
      editor.focus();
      editor.value = '写点东西';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(150);
    check('正文已获得焦点（用户正在输入）', (await focusedNow()) === 'editor', `activeElement=${await focusedNow()}`);

    events.length = 0;
    bounds.length = 0;
    await dragTitlebar(60, 0);
    check('第一次拖动就被识别为拖动', events.some((e) => e.dragging), `收到 ${events.length} 条 dragState`);
    check('拖动过程中窗口位置被更新', bounds.length > 0, `收到 ${bounds.length} 次 setBounds`);
    check(
      '窗口确实向右移动了',
      bounds.length > 0 && bounds[bounds.length - 1].x > WIN_X,
      bounds.length > 0 ? `从 ${WIN_X} 到 ${bounds[bounds.length - 1].x}` : '没有位置更新',
    );

    // -------------------------------------------------------------------------------------------
    // Control: nothing focused, the drag must work too.
    // -------------------------------------------------------------------------------------------
    log('');
    log('=== 对照：没有输入焦点时拖动 ===');
    await blurAll();
    await sleep(120);
    events.length = 0;
    bounds.length = 0;
    await dragTitlebar(40, 0);
    check(
      '无焦点时拖动同样被识别',
      events.some((e) => e.dragging) && bounds.length > 0,
      `${events.length} 条 dragState，${bounds.length} 次 setBounds`,
    );

    // -------------------------------------------------------------------------------------------
    // The regression this guards: a blur mid-drag must not cancel a held gesture.
    //
    // This is the mechanism behind "the first drag does nothing". The old handler ended the gesture on
    // any blur, so the drag died before it counted as started.
    // -------------------------------------------------------------------------------------------
    log('');
    log('=== 回归：拖动中途收到 window blur，不应取消拖动 ===');
    await blurAll();
    await sleep(100);
    events.length = 0;
    bounds.length = 0;

    await pointer('pointerdown', dragX, dragY, 1);
    await pointer('pointermove', dragX + 20, dragY, 1);
    const beforeBlur = bounds.length;
    await win.webContents.executeJavaScript('window.dispatchEvent(new PointerEvent("blur", { buttons: 1 })), true');
    await sleep(60);
    await pointer('pointermove', dragX + 40, dragY, 1);
    await pointer('pointermove', dragX + 60, dragY, 1);
    await sleep(80);
    await pointer('pointerup', dragX + 60, dragY, 0);
    await sleep(120);

    check(
      'blur 之后拖动仍在继续（位置继续更新）',
      bounds.length > beforeBlur,
      `blur 前 ${beforeBlur} 次 setBounds，之后共 ${bounds.length} 次`,
    );

    // -------------------------------------------------------------------------------------------
    // And the other direction: a blur that really does mean "the pointer is gone" must still end the
    // gesture, or a missed drag becomes a stuck one.
    // -------------------------------------------------------------------------------------------
    log('');
    log('=== 对照：按钮已松开 / 无按钮信息的 blur，仍应结束手势 ===');
    events.length = 0;
    await pointer('pointerdown', dragX, dragY, 1);
    await pointer('pointermove', dragX + 20, dragY, 1);
    const started = events.some((e) => e.dragging === true);
    events.length = 0;
    await win.webContents.executeJavaScript('window.dispatchEvent(new PointerEvent("blur", { buttons: 0 })), true');
    await sleep(100);
    check('前置条件：手势已开始', started, '拖动未被识别，对照无效');
    check(
      'buttons=0 的 blur 会结束手势（保留卡死保护）',
      events.some((e) => e.dragging === false),
      `${events.length} 条 dragState`,
    );

    events.length = 0;
    await pointer('pointerdown', dragX, dragY, 1);
    await pointer('pointermove', dragX + 20, dragY, 1);
    events.length = 0;
    await win.webContents.executeJavaScript('window.dispatchEvent(new Event("blur")), true');
    await sleep(100);
    check(
      '没有 buttons 信息的 blur 也会结束手势（保守处理）',
      events.some((e) => e.dragging === false),
      `${events.length} 条 dragState`,
    );

    finish(failures.length === 0 ? 0 : 1);
  } catch (error) {
    log(`运行出错：${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`);
    failures.push('runner threw');
    finish(1);
  }
});
