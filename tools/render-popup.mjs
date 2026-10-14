/**
 * Render the popup window and report what the user would see.
 *
 * The popup is a transparent frameless window sized to `POPUP_WIDTH x POPUP_HEIGHT`,
 * so its appearance cannot be checked from geometry or protocols alone: a clipped
 * row or a missing background looks the same as a working popup to every other test.
 *
 * Usage: node tools/render-popup.mjs [outDir]
 *
 * @module dsh-sticky-notes-desktop/tools/render-popup
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = join(HERE, '..', 'electron');
const outDir = process.argv[2] ?? join(HERE, '.render');
mkdirSync(outDir, { recursive: true });

/** Must match `POPUP_WIDTH` / `POPUP_HEIGHT` in popup.mjs. */
const WIDTH = 168;
const HEIGHT = 88;

app.commandLine.appendSwitch('disable-gpu-compositing-cache');

ipcMain.handle('popup:items', () => ({
  items: [
    { id: 'new-note', label: '新建便签', glyph: '▤' },
    { id: 'shot', label: '截图', glyph: '▣' },
  ],
}));
ipcMain.handle('popup:choose', () => ({ ok: true }));
ipcMain.handle('popup:dismiss', () => ({ ok: true }));

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    transparent: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(ELECTRON_DIR, 'preload-popup.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await window.loadFile(join(ELECTRON_DIR, 'popup.html'));
  await new Promise((resolve) => setTimeout(resolve, 900));

  // Report what was actually laid out, so a clipped or empty row is visible here
  // rather than only in a screenshot.
  const probe = await window.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('.row')];
    const sheet = document.getElementById('sheet');
    return {
      rows: rows.length,
      labels: rows.map((r) => r.textContent.trim()),
      sheetHeight: sheet === null ? null : Math.round(sheet.getBoundingClientRect().height),
      bodyHeight: Math.round(document.body.getBoundingClientRect().height),
      fallbackHidden: document.getElementById('fallback').hasAttribute('hidden'),
      overflow: sheet === null ? null : Math.round(sheet.scrollHeight - sheet.clientHeight),
    };
  })()`);
  console.log('弹窗布局：', JSON.stringify(probe));

  const image = await window.webContents.capturePage();
  const target = join(outDir, 'popup.png');
  writeFileSync(target, image.toPNG());
  console.log(`弹窗截图：${target}`);

  const problems = [];
  if (probe.rows !== 2) problems.push(`应当有 2 行，实际 ${probe.rows}`);
  if (probe.fallbackHidden !== true) problems.push('降级提示条意外显示');
  if (probe.bodyHeight !== HEIGHT) problems.push(`弹窗应正好 ${HEIGHT}px 高，实际 ${probe.bodyHeight}`);
  if (probe.overflow !== 0) problems.push(`内容溢出 ${probe.overflow}px（会被窗口裁掉）`);
  if (!probe.labels.some((label) => label.includes('新建便签'))) problems.push('缺少「新建便签」行');
  if (!probe.labels.some((label) => label.includes('截图'))) problems.push('缺少「截图」行');

  if (problems.length > 0) {
    console.error('弹窗渲染检查失败：');
    for (const problem of problems) console.error(`  - ${problem}`);
    app.exit(1);
    return;
  }
  console.log('弹窗渲染检查通过');
  app.quit();
});
