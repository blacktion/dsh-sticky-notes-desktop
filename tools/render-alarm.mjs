/**
 * Render the 便签闹钟 popup and report what the user would see.
 *
 * Behaviour tests prove the window opens and closes; none of them would notice an empty
 * card, a missing image, or text that overflows. The window is transparent and frameless, so
 * this is the only way to check the card actually draws.
 *
 * Usage: node tools/render-alarm.mjs <outDir>
 *
 * @module dsh-sticky-notes-desktop/tools/render-alarm
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = join(HERE, '..', 'electron');
const outDir = process.argv[2] ?? join(HERE, '.render');
mkdirSync(outDir, { recursive: true });

/** What the page will be told to render, per variant. */
const VARIANTS = [
  {
    name: 'text',
    alarm: { id: 'a1', label: '喝水提醒', kind: 'text', text: '该喝水了。\n站起来走两步，顺便看看窗外。', imageUrl: null },
  },
  {
    name: 'image',
    alarm: { id: 'a2', label: '会议截图', kind: 'image', text: '', imageUrl: null },
  },
];

let current = VARIANTS[0].alarm;
ipcMain.handle('alarm:init', () => ({ alarm: current }));
ipcMain.handle('alarm:close', () => ({ ok: true }));

app.commandLine.appendSwitch('disable-gpu-compositing-cache');

app.whenReady().then(async () => {
  const problems = [];

  for (const variant of VARIANTS) {
    current = variant.alarm;
    if (variant.name === 'image') {
      // A real PNG, generated here rather than shipping a fixture: the point of the image
      // variant is that an actual decoded image lays out inside the card.
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAWklEQVR42u3QMQEAAAgDINe/tDXBzwMh0GXSFRQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFN4NUZAAAV3Z6jkAAAAASUVORK5CYII=',
        'base64',
      );
      const imagePath = join(outDir, 'alarm-fixture.png');
      writeFileSync(imagePath, png);
      // `pathToFileURL`, not string surgery: a hand-built `file://D:/...` is not a valid
      // file URL and Chromium resolves it relative to the document instead.
      current = { ...variant.alarm, imageUrl: pathToFileURL(imagePath).href };
    }

    const window = new BrowserWindow({
      width: 420,
      height: variant.name === 'image' ? 400 : 200,
      frame: false,
      transparent: true,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(ELECTRON_DIR, 'preload-alarm.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    await window.loadFile(join(ELECTRON_DIR, 'alarm.html'));

    // Wait for the image to actually decode before judging it. Reading `naturalWidth`
    // immediately after load reports 0 for a perfectly good image, which is a false failure.
    if (variant.name === 'image') {
      const decoded = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const image = document.getElementById('image');
        const done = () => resolve(true);
        if (image.complete && image.naturalWidth > 0) return resolve(true);
        image.addEventListener('load', done, { once: true });
        image.addEventListener('error', done, { once: true });
        setTimeout(done, 4000);
      })`);
      if (decoded !== true) problems.push('image: 图片既没有加载成功也没有报错');
    }
    await new Promise((resolve) => setTimeout(resolve, 600));

    const probe = await window.webContents.executeJavaScript(`(() => {
      const card = document.getElementById('card');
      const text = document.getElementById('text');
      const image = document.getElementById('image');
      return {
        label: document.getElementById('label').textContent.trim(),
        text: text.hidden ? null : text.textContent.trim(),
        imageVisible: image.hidden !== true,
        imageComplete: image.complete === true,
        imageNatural: image.naturalWidth || 0,
        fallbackShown: document.getElementById('fallback').hidden !== true,
        fallbackText: document.getElementById('fallback').hidden === true ? null : document.getElementById('fallback').textContent,
        cardHeight: card === null ? null : Math.round(card.getBoundingClientRect().height),
        overflow: card === null ? null : Math.round(card.scrollHeight - card.clientHeight),
      };
    })()`);
    console.log(`${variant.name}: ${JSON.stringify(probe)}`);

    if (probe.fallbackShown) problems.push(`${variant.name}: 显示了降级提示 —— ${probe.fallbackText}`);
    if (probe.label.length === 0) problems.push(`${variant.name}: 标题为空`);
    if (variant.name === 'text' && (probe.text === null || probe.text.length === 0)) {
      problems.push('text: 正文没有渲染出来');
    }
    if (variant.name === 'image') {
      if (probe.imageVisible !== true) problems.push('image: 图片没有显示');
      if (probe.imageNatural === 0) problems.push('image: 图片没有解码成功');
    }
    if (probe.overflow > 0) problems.push(`${variant.name}: 内容溢出 ${probe.overflow}px`);

    const shot = await window.webContents.capturePage();
    writeFileSync(join(outDir, `alarm-${variant.name}.png`), shot.toPNG());
    console.log(`${variant.name} 截图：${join(outDir, `alarm-${variant.name}.png`)}`);
    // Left open on purpose: destroying a window whose load is still settling aborts the
    // next `loadFile` with ERR_FAILED. `app.quit()` closes them all at the end.
  }

  if (problems.length > 0) {
    console.error('闹钟外观检查失败：');
    for (const problem of problems) console.error(`  - ${problem}`);
    app.exit(1);
    return;
  }
  console.log('闹钟外观检查通过');
  app.quit();
});
