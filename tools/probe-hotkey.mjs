/**
 * Can this machine actually register the configured hotkey?
 *
 * "I pressed it and nothing happened" has two very different causes: the
 * accelerator is already owned by another application (a very common fate for
 * `Ctrl+Alt+S`, which several screen-capture tools claim), or our own helper
 * never started. This probe separates them by asking Electron directly.
 *
 * It registers nothing permanently: everything it takes is released before exit.
 *
 * Usage: node tools/probe-hotkey.mjs [accelerator...]
 *
 * @module dsh-sticky-notes-desktop/tools/probe-hotkey
 */
import { app, globalShortcut } from 'electron';

const candidates = process.argv.slice(2);
if (candidates.length === 0) {
  candidates.push(
    'CommandOrControl+Alt+S',
    'CommandOrControl+Shift+N',
    'CommandOrControl+Alt+Shift+F8',
    'CommandOrControl+Alt+N',
    'CommandOrControl+Shift+S',
  );
}

app.whenReady().then(() => {
  const report = [];

  for (const accelerator of candidates) {
    let ok = false;
    let error = null;
    try {
      ok = globalShortcut.register(accelerator, () => {});
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    report.push({ accelerator, ok, isRegistered: globalShortcut.isRegistered(accelerator), error });
    if (ok) {
      // Release immediately so the probe never leaves a hotkey behind, and so a
      // later candidate is judged on its own merits.
      try {
        globalShortcut.unregister(accelerator);
      } catch {
        /* ignore */
      }
    }
  }

  for (const entry of report) {
    const verdict = entry.ok ? '可用' : entry.error === null ? '已被其他程序占用' : `注册抛错：${entry.error}`;
    console.log(`${entry.accelerator}\t${verdict}`);
  }

  // A sanity check that the API itself works in this process: if even a
  // nonsense accelerator fails for an unexpected reason, the environment is the
  // problem, not the specific key.
  const control = 'CommandOrControl+Alt+Shift+F12';
  let controlOk = false;
  try {
    controlOk = globalShortcut.register(control, () => {});
  } catch {
    controlOk = false;
  }
  console.log(`${control}\t${controlOk ? '可用（对照项，API 正常）' : '不可用（对照项也失败 → 环境异常）'}`);
  try {
    globalShortcut.unregister(control);
  } catch {
    /* ignore */
  }

  app.quit();
});
