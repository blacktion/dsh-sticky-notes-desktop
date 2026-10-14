/**
 * Minimal measurement: does Windows let a window sit fully off the display?
 *
 * Kept deliberately tiny — one window, explicit numbers — because the answer
 * decides whether "hide entirely off-screen" is implementable at all, or whether
 * the visible sliver is mandatory.
 *
 * Usage: node tools/probe-offscreen.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/probe-offscreen
 */
import { app, BrowserWindow, screen } from 'electron';

app.commandLine.appendSwitch('disable-gpu-compositing-cache');

app.whenReady().then(async () => {
  const area = screen.getPrimaryDisplay().workArea;
  console.log(`工作区：x=${area.x} y=${area.y} ${area.width}x${area.height}`);

  const width = 260;
  const height = 200;

  const window = new BrowserWindow({
    width,
    height,
    x: area.x + 200,
    y: area.y + 200,
    frame: false,
    show: true,
    skipTaskbar: true,
    focusable: false,
    transparent: true,
    backgroundColor: '#00000000',
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  console.log(`初始：${JSON.stringify(window.getBounds())}`);

  /** Ask for one rectangle and report what came back. */
  const attempt = async (label, wanted) => {
    window.setBounds({ ...window.getBounds(), ...wanted });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const got = window.getBounds();
    const left = Math.max(got.x, area.x);
    const right = Math.min(got.x + got.width, area.x + area.width);
    const top = Math.max(got.y, area.y);
    const bottom = Math.min(got.y + got.height, area.y + area.height);
    const visible = Math.max(0, right - left) * Math.max(0, bottom - top);
    const pct = ((visible / (got.width * got.height)) * 100).toFixed(1);
    console.log(
      `${label}\n  请求 ${JSON.stringify(wanted)} → 实际 x=${got.x} y=${got.y} ${got.width}x${got.height}，可见 ${pct}%`,
    );
    return got;
  };

  // Right edge: the note's left edge sits exactly on the screen's right boundary.
  await attempt('完全移出右侧（x = 工作区右边界）', { x: area.x + area.width });
  await attempt('完全移出右侧（再远 200px）', { x: area.x + area.width + 200 });
  // Right edge with a small sliver still on screen.
  await attempt('右侧只留 4px', { x: area.x + area.width - 4 });
  await attempt('右侧只留 2px', { x: area.x + area.width - 2 });
  await attempt('右侧只留 1px', { x: area.x + area.width - 1 });
  // Left edge.
  await attempt('完全移出左侧（x = -宽度）', { x: area.x - width });
  await attempt('左侧只留 4px', { x: area.x - width + 4 });
  // Vertical.
  await attempt('完全移出上方（y = -高度）', { y: area.y - height });
  await attempt('上方只留 4px', { y: area.y - height + 4 });
  await attempt('完全移出下方（y = 工作区下边界）', { y: area.y + area.height });
  await attempt('下方只留 4px', { y: area.y + area.height - 4 });

  window.destroy();
  app.quit();
});
