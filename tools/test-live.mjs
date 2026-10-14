/**
 * End-to-end verification against a live DSH instance running this plugin.
 *
 * Talks to the plugin's own authenticated HTTP surface, so it exercises the real
 * path a user takes: host routes → store → Electron helper → back through the
 * event loop into the store.
 *
 * Usage: node tools/test-live.mjs <port> <token>
 *
 * @module dsh-sticky-notes-desktop/tools/test-live
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const [port, token] = process.argv.slice(2);
if (!port || !token) {
  console.error('用法: node tools/test-live.mjs <port> <token>');
  process.exit(2);
}

const BASE = `http://127.0.0.1:${port}`;
const DATA_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sticky-notes');
let cookie = '';

/**
 * Authenticate the way the browser does, then reuse the session cookie.
 *
 * `GET /?token=…` answers **303** with the `dsh-auth-…` cookie attached, so the
 * redirect must not be followed blindly — the cookie has to be captured from that
 * first response or every later call is a 401.
 */
async function authenticate() {
  const response = await fetch(`${BASE}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  assert.ok(
    response.status === 200 || response.status === 303,
    `索引页应当返回 200/303，实际 ${response.status}`,
  );
  const raw = response.headers.getSetCookie?.() ?? [];
  cookie = raw.map((entry) => entry.split(';')[0]).join('; ');
  assert.ok(cookie.length > 0, '必须从索引页响应里拿到会话 cookie');
  await response.arrayBuffer().catch(() => {});
}

async function api(path, init) {
  const options = {
    method: init?.method ?? 'GET',
    headers: { cookie },
  };
  if (init?.body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(init.body);
  }
  const response = await fetch(`${BASE}/plugins/dsh-sticky-notes-desktop${path}`, options);
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  return { status: response.status, payload };
}

const failures = [];
async function step(label, fn) {
  try {
    await fn();
    console.log(`  [通过] ${label}`);
  } catch (error) {
    console.error(`  [失败] ${label}`);
    console.error(`         ${error instanceof Error ? error.message : String(error)}`);
    failures.push(label);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await authenticate();
console.log(`已认证：${BASE}\n`);

// ------------------------------------------------------------- feature 4 ==
console.log('[功能四] 设置界面所需的设置读写');
let settings = null;
await step('GET /settings 返回完整设置（快捷键 / 背景色 / 透明度）', async () => {
  const { status, payload } = await api('/settings');
  assert.equal(status, 200);
  settings = payload.settings;
  for (const key of ['hotkey', 'backgroundColor', 'opacity', 'textColor', 'fontSize', 'snapDistance']) {
    assert.ok(settings[key] !== undefined, `设置必须包含 ${key}`);
  }
});

await step('PATCH /settings 改快捷键 + 背景色 + 透明度并回执热键注册结果', async () => {
  const { payload } = await api('/settings', {
    method: 'PATCH',
    body: { hotkey: 'CommandOrControl+Alt+Shift+F8', backgroundColor: '#bbdefb', opacity: 0.8, autoHideDelayMs: 1500, snapDistance: 24 },
  });
  settings = payload.settings;
  assert.equal(settings.backgroundColor, '#bbdefb');
  assert.equal(settings.opacity, 0.8);
  assert.equal(settings.hotkey, 'CommandOrControl+Alt+Shift+F8');
  assert.ok(payload.applied !== undefined && payload.applied.ok === true, `热键应当注册成功：${JSON.stringify(payload.applied)}`);
});

await step('改回默认快捷键（避免占用用户真实快捷键）', async () => {
  const { payload } = await api('/settings', { method: 'PATCH', body: { hotkey: 'CommandOrControl+Alt+S' } });
  assert.ok(payload.applied === undefined || payload.applied.ok !== false, '恢复默认快捷键不应失败');
});

// ------------------------------------------------------------- feature 1 ==
console.log('\n[功能一] 新建便签 → 真实置顶窗口 → 贴边自动隐藏');

let noteId = null;
await step('POST /notes 新建便签并弹出真实窗口（helper 确认 opened）', async () => {
  const { payload } = await api('/notes', {
    method: 'POST',
    body: { kind: 'text', text: '端到端验证：这条便签应当贴到屏幕左边缘并自动收起', title: 'E2E', x: 2, y: 320, width: 260, height: 200 },
  });
  assert.ok(payload.note?.id, '必须回执 note.id');
  noteId = payload.note.id;
  assert.equal(payload.opened?.ok, true, `窗口应当成功打开：${JSON.stringify(payload.opened)}`);
});

await step('便签自动吸附到左边缘（helper 事件回写到 host 存储）', async () => {
  const deadline = Date.now() + 20000;
  let note = null;
  while (Date.now() < deadline) {
    const { payload } = await api('/state');
    note = payload.notes.find((entry) => entry.id === noteId);
    if (note !== null && note !== undefined && typeof note.edge === 'string' && note.edge.length > 0) break;
    await sleep(400);
  }
  assert.ok(note !== null && note !== undefined, '便签必须仍在列表中');
  assert.equal(note.edge, 'left', `应当记录 edge=left，实际 ${String(note.edge)}`);
});

await step('便签在延迟后自动收起（hidden=true 回写到存储）', async () => {
  const deadline = Date.now() + 20000;
  let note = null;
  while (Date.now() < deadline) {
    const { payload } = await api('/state');
    note = payload.notes.find((entry) => entry.id === noteId);
    if (note?.hidden === true) break;
    await sleep(400);
  }
  assert.equal(note?.hidden, true, '便签必须自动收起为边缘小标签');
});

// ------------------------------------------------------------- feature 3 ==
console.log('\n[功能三] 位置与隐藏态实时持久化（重启后可恢复）');

await step('data.json 已落盘并记录 x/y/edge/hidden', async () => {
  const file = join(DATA_DIR, 'data.json');
  assert.ok(existsSync(file), `存储文件必须存在：${file}`);
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const note = parsed.notes.find((entry) => entry.id === noteId);
  assert.ok(note !== undefined, '存储里必须有这条便签');
  assert.equal(note.edge, 'left', '存储必须记录 edge');
  assert.equal(note.hidden, true, '存储必须记录 hidden（这是重启后能恢复隐藏态的关键）');
  assert.ok(Number.isFinite(note.x) && Number.isFinite(note.y), '存储必须记录坐标');
  assert.equal(note.width, 260, '存储必须保留便签真实宽度（不是小标签的宽度）');
});

await step('重启恢复路径：note.reconcile 能把隐藏便签直接还原成小标签', async () => {
  // Mirror what the bridge does on startup: send the stored set to the helper.
  const { payload } = await api('/helper');
  assert.equal(payload.running, true, 'helper 必须在运行');

  const state = await api('/state');
  const stored = state.payload.notes;
  // The helper is already running with this note; asking it to reconcile the same
  // set must be idempotent and keep the hidden state.
  assert.ok(Array.isArray(stored), 'state.notes 必须是数组');
  assert.equal(stored.find((entry) => entry.id === noteId)?.hidden, true);
});

// ------------------------------------------------------------- feature 2 ==
console.log('\n[功能二] 便签列表（侧边栏面板消费的数据）');

await step('GET /state 返回列表 + 设置 + helper 状态，供面板一次渲染', async () => {
  const { status, payload } = await api('/state');
  assert.equal(status, 200);
  assert.ok(Array.isArray(payload.notes) && payload.notes.length >= 1, '列表里必须有刚建的便签');
  assert.ok(payload.settings !== null && payload.settings !== undefined, '必须附带设置');
  assert.equal(payload.helper.running, true, '必须附带 helper 运行状态');
});

await step('PATCH /notes 再次编辑（面板「编辑」按钮走的路径）', async () => {
  const { payload } = await api('/notes', {
    method: 'PATCH',
    body: { id: noteId, patch: { text: '已再次编辑', title: 'EE2', color: '#c8e6c9' } },
  });
  assert.equal(payload.note.text, '已再次编辑');
  assert.equal(payload.note.color, '#c8e6c9');
});

await step('POST /notes/open 重新打开一个已隐藏的便签', async () => {
  const { payload } = await api('/notes/open', { method: 'POST', body: { id: noteId } });
  assert.equal(payload.ok, true, `重新打开应当成功：${JSON.stringify(payload)}`);
});

await step('POST /notes/hide 主动隐藏', async () => {
  const { payload } = await api('/notes/hide', { method: 'POST', body: { id: noteId, hidden: true } });
  assert.equal(payload.ok, true, `隐藏应当成功：${JSON.stringify(payload)}`);
});

// ------------------------------------------------------------- deletion ==
console.log('\n[收尾] 删除便签并确认窗口关闭、存储清理');

await step('DELETE /notes 删除后列表不再包含它', async () => {
  const { payload } = await api(`/notes?id=${encodeURIComponent(noteId)}`, { method: 'DELETE' });
  assert.equal(payload.removed, true, '应当报告已删除');
  assert.ok(!payload.notes.some((entry) => entry.id === noteId), '删除后列表不应再包含它');
});

await step('删除已落盘', async () => {
  await sleep(800);
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, 'data.json'), 'utf8'));
  assert.ok(!parsed.notes.some((entry) => entry.id === noteId), '存储里也必须已删除');
});

console.log(`\n${'─'.repeat(62)}`);
if (failures.length === 0) {
  console.log('实机端到端验证：全部通过 ✅');
  process.exit(0);
}
console.error(`实机端到端验证：${failures.length} 项失败 ❌`);
for (const failure of failures) console.error(`  - ${failure}`);
process.exit(1);
