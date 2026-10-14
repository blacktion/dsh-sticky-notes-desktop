/**
 * Render `electron/note.html` in a real window and screenshot it.
 *
 * The note window is the one surface that no unit test can judge: its whole
 * contract is "is this readable at this size and transparency". This harness
 * loads the real page with the real stylesheet and stands in for the preload,
 * so a contrast problem — dark title-bar buttons on a black note, a grip you
 * cannot see — shows up as a picture instead of a guess.
 *
 * Usage: node tools/render-note.mjs <case> [outDir]
 *
 * One case per process: reusing a destroyed `BrowserWindow`'s session for a
 * second `loadFile` fails with ERR_FAILED, and a fresh process is also a truer
 * stand-in for a real note window (which owns its own process).
 *
 * @module dsh-sticky-notes-desktop/tools/render-note
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = join(HERE, '..', 'electron');

const CASE_NAME = process.argv[2] ?? 'default-black';
const outDir = process.argv[3] ?? join(HERE, '.render');
mkdirSync(outDir, { recursive: true });

/** The appearances worth looking at: the new default, plus a light one. */
const CASES = {
  'default-black': { color: '#000000', opacity: 0.8, textColor: '#f5f5f5' },
  'classic-yellow': { color: '#fff3b0', opacity: 1, textColor: '#3b3320' },
  blue: { color: '#bbdefb', opacity: 0.9, textColor: '#10243a' },
};

const note = CASES[CASE_NAME];
if (note === undefined) {
  console.error(`未知用例：${CASE_NAME}（可用：${Object.keys(CASES).join(', ')}）`);
  app.exit(2);
}

/**
 * Stand in for `electron/preload-note.cjs`.
 *
 * The page talks to the main process only through `window.sticky`; the minimal
 * set below is enough for a first paint, which is all this harness inspects.
 */
function installStub() {
  ipcMain.handle('note:init', () => ({
    note: {
      id: 'render-note',
      kind: 'text',
      title: '便签标题',
      text: '这是一条便签的正文示例。\n第二行用来检查行距与滚动区域。',
      hidden: false,
      edge: null,
      fontSize: 14,
      alwaysOnTop: true,
      ...note,
    },
    settings: { fontSize: 14 },
  }));
  for (const channel of [
    'note:save',
    'note:update',
    'note:close',
    'note:delete',
    'note:hide',
    'note:pickColor',
    'note:exportImage',
    'note:commitText',
    'note:setBounds',
    'note:setSize',
    'note:dragState',
  ]) {
    ipcMain.handle(channel, () => ({ ok: true }));
  }
}

/**
 * Relative luminance of an `rgb(...)` string, per WCAG.
 * @param {string} rgb
 * @returns {number}
 */
function luminanceOf(rgb) {
  const parts = String(rgb).match(/\d+(\.\d+)?/g);
  if (parts === null || parts.length < 3) return 0;
  const [r, g, b] = parts.slice(0, 3).map((value) => {
    const channel = Number(value) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two luminances. */
function contrastRatio(a, b) {
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Parse `#rrggbb` into `rgb(...)` so it can be compared with computed styles. */
function toRgb(hex) {
  const value = String(hex).replace('#', '');
  const full =
    value.length === 3
      ? value[0] + value[0] + value[1] + value[1] + value[2] + value[2]
      : value;
  return `rgb(${parseInt(full.slice(0, 2), 16)}, ${parseInt(full.slice(2, 4), 16)}, ${parseInt(full.slice(4, 6), 16)})`;
}

app.commandLine.appendSwitch('disable-gpu-compositing-cache');

app.whenReady().then(async () => {
  installStub();

  const window = new BrowserWindow({
    width: 280,
    height: 220,
    frame: false,
    transparent: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(ELECTRON_DIR, 'preload-note.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await window.loadFile(join(ELECTRON_DIR, 'note.html'));
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Report the colours the page actually resolved, so a contrast problem can be
  // attributed to the stylesheet, the variables, or the initial state.
  const probe = await window.webContents.executeJavaScript(`(() => {
    const app = document.getElementById('app');
    const style = getComputedStyle(app);
    const button = document.getElementById('btn-save');
    return {
      noteFg: style.getPropertyValue('--note-fg').trim(),
      noteBgColor: style.getPropertyValue('--note-bg-color').trim(),
      bodyColor: getComputedStyle(document.body).color,
      buttonColor: getComputedStyle(button).color,
      titleColor: getComputedStyle(document.getElementById('title-input')).color,
      gripColor: style.getPropertyValue('--note-grip').trim(),
      fallbackHidden: document.getElementById('fallback').hasAttribute('hidden'),
    };
  })()`);
  console.log(`  ${CASE_NAME} computed:`, JSON.stringify(probe));

  const image = await window.webContents.capturePage();
  const target = join(outDir, `${CASE_NAME}.png`);
  writeFileSync(target, image.toPNG());
  console.log(`${CASE_NAME}: ${image.getSize().width}x${image.getSize().height} → ${target}`);

  // The note's own text colour must reach the controls. Every control inherits
  // from `body`, so if the appearance variables are declared anywhere below it
  // (on `#app`, say) `body` cannot see them and everything silently falls back to
  // the dark default — which is exactly how the black note shipped with
  // unreadable title-bar buttons.
  const expected = toRgb(note.textColor);
  const problems = [];
  if (probe.bodyColor !== expected) problems.push(`body 正文色 ${probe.bodyColor} ≠ ${expected}`);
  if (probe.buttonColor !== expected) problems.push(`标题栏按钮色 ${probe.buttonColor} ≠ ${expected}`);
  if (probe.titleColor !== expected) problems.push(`标题输入色 ${probe.titleColor} ≠ ${expected}`);
  if (probe.noteFg !== note.textColor) problems.push(`--note-fg ${probe.noteFg} ≠ ${note.textColor}`);
  if (probe.fallbackHidden !== true) problems.push('降级提示条意外显示');

  const ratio = contrastRatio(luminanceOf(expected), luminanceOf(toRgb(note.color)));
  if (ratio < 4.5) problems.push(`前景/背景对比度仅 ${ratio.toFixed(2)}:1，低于 4.5:1`);

  if (problems.length > 0) {
    console.error(`${CASE_NAME}: 外观检查失败`);
    for (const problem of problems) console.error(`  - ${problem}`);
    app.exit(1);
    return;
  }
  console.log(`${CASE_NAME}: 外观检查通过（对比度 ${ratio.toFixed(2)}:1）`);
  app.quit();
});
