/**
 * Render `docs/note-black.png`: the default note as it actually appears on a desktop.
 *
 * ## Why this is not `render-note.mjs`
 *
 * The note window is transparent and its background layer sits at 80% opacity, so a capture of the bare
 * window composites it over *nothing* — the result reads as a muddy near-black that looks nothing like
 * the note on a real desktop. `render-note.mjs` is right to capture the bare window, because it is
 * asserting colours and geometry; a documentation screenshot has to show the note as the user sees it.
 *
 * So the page is rendered with a neutral desktop-coloured backdrop behind it.
 *
 * Usage: electron tools/render-docs-image.mjs [outDir]
 *
 * @module dsh-sticky-notes-desktop/tools/render-docs-image
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = join(HERE, '..', 'electron');
const outDir = resolve(process.argv[2] ?? join(tmpdir(), 'sticky-docs'));

// Must match `DEFAULT_NOTE_WIDTH` / `DEFAULT_NOTE_HEIGHT` in lib/host/geometry.js.
const WIDTH = 300;
const HEIGHT = 200;

// A light desktop tone, matching the light theme most readers will see on GitHub.
//
// A mid-grey backdrop was tried first and made a poor screenshot: the note is 80% black, so it landed at
// roughly 24% luminance against a 24%-luminance backdrop and the note's edges disappeared. A light
// backdrop gives the dark note a visible boundary, which is the whole reason the image is there.
const BACKDROP = { r: 0xe8, g: 0xea, b: 0xed };

mkdirSync(outDir, { recursive: true });

/**
 * The backdrop is injected into the note page rather than framed behind it with an `<iframe>`.
 *
 * The iframe version rendered nothing: `capturePage` returns an empty page, so the screenshot came out
 * as a flat rectangle of the backdrop colour. Painting `html` behind the note's own layers gives the same
 * compositing — the note's background layer is translucent and now has something to blend with — without
 * a second document to load, and the note page keeps its own preload and IPC.
 */
function installStub() {
  ipcMain.handle('note:init', () => ({
    note: {
      id: 'docs',
      kind: 'text',
      title: '便签标题',
      text: '这是一条便签的正文示例。\n第二行用来检查行距与滚动区域。',
      color: '#000000',
      opacity: 0.8,
      textColor: '#f5f5f5',
      fontSize: 14,
      hidden: false,
      edge: null,
      alwaysOnTop: true,
    },
    settings: { fontSize: 14 },
  }));
  for (const channel of [
    'note:save', 'note:update', 'note:commitText', 'note:setPinned', 'note:setSize',
    'note:exportImage', 'note:close', 'note:hide', 'note:delete', 'note:setBounds',
  ]) {
    ipcMain.handle(channel, () => ({ ok: true }));
  }
  ipcMain.on('note:dragState', () => {});
}

app.whenReady().then(async () => {
  installStub();

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    show: false,
    backgroundColor: `#${BACKDROP.r.toString(16)}${BACKDROP.g.toString(16)}${BACKDROP.b.toString(16)}`,
    webPreferences: {
      preload: join(ELECTRON_DIR, 'preload-note.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await win.loadFile(join(ELECTRON_DIR, 'note.html'));
  await new Promise((r) => setTimeout(r, 1200));

  // Appended as a real element rather than via `insertCSS`, because that kept losing to the page's own
  // rules: the first attempt painted `html`, which sits *behind* the note's `.note-bg` layer, so at 80%
  // opacity the note still composited against nothing and the screenshot stayed uniformly dark.
  await win.webContents.executeJavaScript(`(() => {
    const style = document.createElement('style');
    style.textContent = 'html,body{background:rgb(${BACKDROP.r},${BACKDROP.g},${BACKDROP.b}) !important}';
    document.head.appendChild(style);
    return getComputedStyle(document.body).backgroundColor;
  })()`);
  await new Promise((r) => setTimeout(r, 400));

  const image = await win.webContents.capturePage();
  const target = join(outDir, 'note-black.png');
  writeFileSync(target, image.toPNG());

  // Verify the shipped image rather than assuming it: the size and the resolved toolbar ink are the two
  // facts a reader would notice if they were wrong, and both have been wrong in earlier attempts.
  const probe = await win.webContents.executeJavaScript(`(() => {
    const root = getComputedStyle(document.documentElement);
    const bar = document.getElementById('titlebar');
    const btnTops = new Set([...document.querySelectorAll('.actions .tb-btn')]
      .filter((b) => b.offsetParent !== null)
      .map((b) => Math.round(b.getBoundingClientRect().top)));
    return {
      buttonColor: getComputedStyle(document.getElementById('btn-save')).color,
      ink: root.getPropertyValue('--note-ink').trim(),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      buttonRows: btnTops.size,
      barHeight: Math.round(bar.getBoundingClientRect().height),
    };
  })()`);

  const problems = [];
  if (image.getSize().width !== WIDTH || image.getSize().height !== HEIGHT) {
    problems.push(`尺寸应为 ${WIDTH}x${HEIGHT}，实际 ${image.getSize().width}x${image.getSize().height}`);
  }
  if (probe.ink !== '#ffffff') problems.push(`黑底便签的墨色应为白色，实际 ${probe.ink}`);
  if (probe.buttonRows !== 1) problems.push(`按钮换行了（占 ${probe.buttonRows} 行）`);
  if (probe.bodyBackground === 'rgba(0, 0, 0, 0)') problems.push('背景未注入，截图会是透明的');

  console.log(`note-black.png: ${image.getSize().width}x${image.getSize().height} → ${target}`);
  console.log(`  墨色 ${probe.ink} · 按钮文字 ${probe.buttonColor} · 按钮 ${probe.buttonRows} 行 · 背景 ${probe.bodyBackground}`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`  ❌ ${p}`);
    win.destroy();
    app.exit(1);
    return;
  }
  console.log('  文档截图检查通过 ✅');
  win.destroy();
  app.quit();
});
