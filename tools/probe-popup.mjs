/**
 * Why the popup is no longer a native `Menu`.
 *
 * This probe measures the two facts that forced the rewrite, and is kept so the
 * decision can be re-checked on another machine instead of being taken on trust:
 *
 *   1. `Menu.popup` refuses to open at all when the process owns no window
 *      ("Cannot open Menu without a BaseWindow present") — which is the state a
 *      freshly started helper is in, because the popup is what creates the first
 *      note.
 *   2. That failure arrives as a *rejected promise*, not a throw, so the try/catch
 *      around the call reported nothing and the user simply saw "no reaction".
 *
 * With a window supplied the menu does open — which is what the hidden anchor
 * window worked around. The anchor is gone now only because the native menu's
 * dismissal callback proved unreliable on Windows; see `tools/test-popup.mjs` for
 * the rules the owned popup window guarantees instead.
 *
 * Usage: node tools/probe-popup.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/probe-popup
 */
import { app, BrowserWindow, Menu, screen } from 'electron';

const log = (message) => console.log(message);

app.commandLine.appendSwitch('disable-gpu-compositing-cache');

app.whenReady().then(async () => {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  log(`光标位置：${cursor.x},${cursor.y}（显示器工作区 ${display.workArea.width}x${display.workArea.height}）`);

  const before = BrowserWindow.getAllWindows().length;
  log(`弹出前窗口数：${before}`);

  let anchor = null;
  log('--- 场景 A：没有 BaseWindow（复现用户遇到的「没反应」）---');
  const bare = Menu.buildFromTemplate([{ label: '探针', click: () => {} }]);
  try {
    bare.popup({ x: Math.round(cursor.x), y: Math.round(cursor.y) });
    log('  裸 popup 未抛错（异步失败）');
  } catch (error) {
    log(`  裸 popup 抛错：${error instanceof Error ? error.message : String(error)}`);
  }
  bare.closePopup();

  log('--- 场景 B：提供一个隐藏锚点窗口 ---');
  anchor = new BrowserWindow({
    width: 1,
    height: 1,
    x: 0,
    y: 0,
    show: false,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { sandbox: true },
  });
  await anchor.loadURL('data:text/html,<html><body></body></html>');
  log(`  锚点窗口就绪，窗口数：${BrowserWindow.getAllWindows().length}`);

  let closedCallback = false;
  const menu = Menu.buildFromTemplate([
    { label: '新建便签（探针）', click: () => log('  菜单被点击：new-note') },
    { label: '截图（探针）', click: () => log('  菜单被点击：shot') },
  ]);

  let threw = false;
  try {
    menu.popup({
      window: anchor,
      x: Math.round(cursor.x),
      y: Math.round(cursor.y),
      callback: () => {
        closedCallback = true;
      },
    });
  } catch (error) {
    threw = true;
    log(`  带窗口 popup 抛错：${error instanceof Error ? error.message : String(error)}`);
  }

  if (!threw) {
    // Let the menu actually map first, then close it and give the callback every
    // chance to arrive. Measuring both in one shot is what produced a self-
    // contradictory verdict earlier: the timer could win the race against
    // `closePopup()`, reporting "opened" while `closedCallback` was still false.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    log('  菜单已显示，现在主动关闭它，看关闭回调是否到达…');
    try {
      menu.closePopup();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  log(`  关闭回调是否触发：${closedCallback ? '是' : '否'}`);

  if (threw) {
    log('结论：传入 BaseWindow 后仍然打不开 —— 需要重新评估。');
  } else if (closedCallback) {
    log('结论：菜单能显示，且关闭回调正常触发 —— 原生菜单在这台机器上是可用的。');
  } else {
    // This is the measurement that forced the rewrite. The menu opened, then ran
    // its dismissal path without ever invoking `callback`, so the caller's promise
    // was never settled and the "a popup is open" state was never cleared.
    log('结论：菜单能显示，但关闭回调**没有触发**。');
    log('      这就是「点了外面菜单不消失、而且之后按快捷键全都没反应」的成因：');
    log('      状态只由这个回调清掉，回调不来，弹窗就会被永久当成「还开着」。');
    log('      因此弹窗改为插件自己拥有的 HTML 窗口，不再依赖 Menu.popup 的回调。');
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  app.quit();
});
