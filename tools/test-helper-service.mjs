/**
 * 便签服务 status and its start / restart / stop controls, through the real host.
 *
 * The point of the feature is being able to tell "running" from "not answering" and to recover
 * from either, so this exercises the actual helper process rather than mocking the bridge: a
 * status that reads correctly but cannot be acted on is the failure mode worth catching.
 *
 * Usage: node tools/test-helper-service.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/test-helper-service
 */
import { StickyStore } from '../lib/host/store.js';
import { StickyBridge } from '../lib/host/bridge.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const dataDir = mkdtempSync(join(tmpdir(), 'sticky-svc-'));
const failures = [];
const noop = () => {};
const log = { info: noop, warn: noop, error: noop, debug: noop };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const store = new StickyStore({ dir: dataDir, log });
store.load();
store.updateSettings({ autoStartHelper: false, hotkey: '' });

const bridge = new StickyBridge({ store, dataDir, log });

/**
 * Reproduce the `/helper` route's verdict from the same inputs it uses.
 *
 * Written out here rather than imported so the test asserts on the *contract* the settings page
 * depends on (`state`), not on the implementation happening to agree with itself.
 */
async function probe() {
  const status = bridge.status;
  const listed = await bridge.displays();
  const displays = Array.isArray(listed?.displays) ? listed.displays : [];
  const responsive = status.running === true && displays.length > 0;
  return {
    running: status.running === true,
    responsive,
    displays: displays.length,
    state: responsive ? 'running' : status.running === true ? 'unresponsive' : 'stopped',
    hotkey: status.hotkey ?? null,
  };
}

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

try {
  await step('一开始"未运行"：不能把没启动过说成正在运行', async () => {
    const status = await probe();
    console.log(`         ${JSON.stringify(status)}`);
    assert.equal(status.running, false, '前置条件：助手还没启动');
    assert.equal(status.state, 'stopped', `应当是 stopped，实际 ${status.state}`);
    assert.equal(status.responsive, false);
  });

  await step('启动后变成"正在运行"，并且真的能应答', async () => {
    const started = await bridge.start();
    assert.equal(started.running, true, `启动应当成功：${JSON.stringify(started)}`);

    const status = await probe();
    console.log(`         ${JSON.stringify(status)}`);
    assert.equal(status.state, 'running', `应当报 running，实际 ${status.state}`);
    assert.equal(status.responsive, true, 'running 必须意味着真的应答了');
    assert.ok(status.displays >= 1, `应当能查到显示器，实际 ${status.displays}`);
  });

  await step('重启后仍然是"正在运行"（重启不能把服务弄坏）', async () => {
    // The same sequence the /helper/restart route performs.
    await bridge.stop();
    await sleep(600);
    const restarted = await bridge.start();
    assert.equal(restarted.running, true, `重启应当成功：${JSON.stringify(restarted)}`);

    const status = await probe();
    console.log(`         ${JSON.stringify(status)}`);
    assert.equal(status.state, 'running', `重启后应当报 running，实际 ${status.state}`);
    assert.equal(status.responsive, true, '重启后必须真的能应答');
  });

  await step('停止后回到"未运行"', async () => {
    await bridge.stop();
    await sleep(400);
    const status = await probe();
    console.log(`         ${JSON.stringify(status)}`);
    assert.equal(status.running, false, '停止后 running 必须是 false');
    assert.equal(status.state, 'stopped', `应当报 stopped，实际 ${status.state}`);
  });

  await step('停止后还能再启动（反复启停不会卡住）', async () => {
    const started = await bridge.start();
    assert.equal(started.running, true, '再次启动应当成功');
    const status = await probe();
    assert.equal(status.state, 'running', `实际 ${status.state}`);
  });

  await step('假死的助手会被报成"无响应"，而不是"正在运行"', async () => {
    // Simulate the wedged case: the host still believes it is running, but nothing answers. This
    // is the state a restart exists for, so reporting it as "running" would defeat the feature.
    const original = bridge.displays.bind(bridge);
    bridge.displays = async () => ({ displays: [] });
    const status = await probe();
    bridge.displays = original;
    console.log(`         ${JSON.stringify(status)}`);
    assert.equal(status.running, true, '前置条件：host 仍然认为它在运行');
    assert.equal(status.responsive, false, '不应答就不能算 responsive');
    assert.equal(status.state, 'unresponsive', `应当报 unresponsive，实际 ${status.state}`);
  });
} catch (error) {
  console.error('\n服务状态测试异常终止：', error);
  failures.push('未捕获异常');
} finally {
  await bridge.dispose().catch(() => {});
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(62)}`);
if (failures.length === 0) {
  console.log('便签服务状态测试：全部通过 ✅');
  process.exit(0);
}
console.error(`便签服务状态测试：${failures.length} 项失败 ❌`);
for (const failure of failures) console.error(`  - ${failure}`);
process.exit(1);
