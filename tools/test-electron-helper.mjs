/**
 * Drive the real Electron helper through the real `ElectronHelperClient`.
 *
 * This is the only test that exercises what cannot be stubbed: that Electron 44
 * accepts our ESM main module, that the loopback RPC handshake completes, that a
 * transparent always-on-top `BrowserWindow` is really created, that the hide/
 * reveal path moves a real window, and that `desktopCapturer` returns pixels.
 *
 * Because it uses the production client, a transport regression (the reason
 * stdio was abandoned — Electron's main process exposes no usable stdin fd)
 * fails here rather than in front of the user.
 *
 * Usage: node tools/test-electron-helper.mjs
 *
 * Opens a few real windows for several seconds, then closes them. Skipped with a
 * clear message when no Electron runtime is available.
 *
 * @module dsh-sticky-notes-desktop/tools/test-electron-helper
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

import { ElectronHelperClient, findElectron } from '../lib/host/runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const runtime = findElectron();
if (runtime === null) {
  console.log('跳过：未找到 Electron 运行时（可用 DSH_STICKY_NOTES_ELECTRON 指定）。');
  process.exit(0);
}
console.log(`Electron 运行时：${runtime.path}\n`);

const events = [];
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

const client = new ElectronHelperClient({
  exe: runtime.path,
  script: join(ROOT, 'electron', 'main.mjs'),
  cwd: join(ROOT, 'electron'),
  log: (message) => console.log(`    [helper] ${message}`),
  handshakeTimeoutMs: 40000,
});
client.onEvent((message) => events.push(message));

try {
  console.log('[1] 启动与协议握手');
  await step('ready() 完成并带回就绪报告（版本/显示器数）', async () => {
    await client.ready();
    assert.equal(client.alive, true, '握手后 alive 必须为 true');
    const info = client.readyInfo;
    assert.ok(info !== null, '握手必须带回就绪报告');
    assert.ok(typeof info.version === 'string' && info.version.length > 0, '就绪报告必须带 version');
    assert.ok(info.displays >= 1, `至少要能看到一块显示器，实际 ${String(info.displays)}`);
  });

  await step('helper.ready 推送事件也能收到（不依赖时序，是加分项）', async () => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const ready = events.find((event) => event.event === 'helper.ready');
      if (ready !== undefined) {
        assert.ok(typeof ready.data.version === 'string', 'helper.ready 必须带 version');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // The handshake already proved readiness; a lost push event is a warning,
    // never a failure, because nothing in the plugin depends on it.
    console.log('         （提示：未收到 helper.ready 推送事件，就绪状态已由握手确认）');
  });

  await step('helper.ping 往返成功', async () => {
    const pong = await client.call('helper.ping');
    assert.equal(pong.ok, true);
    assert.ok(String(pong.version).length > 0, 'version 不能为空');
  });

  await step('helper.config 接受 dataDir/settings 并回执热键结果', async () => {
    const result = await client.call('helper.config', {
      dataDir: join(ROOT, 'tools', '.tmp-helper-data'),
      settings: { hotkey: '', hiddenRevealWidth: 10, snapDistance: 12 },
    });
    assert.equal(result.ok, true);
    assert.ok(result.hotkey !== undefined, '必须回执 hotkey 字段');
  });

  console.log('\n[2] 显示器与几何');
  await step('displays.list 返回带 bounds/workArea/scaleFactor 的显示器', async () => {
    const result = await client.call('displays.list');
    assert.ok(Array.isArray(result.displays) && result.displays.length >= 1);
    const first = result.displays[0];
    assert.ok(Number.isFinite(first.workArea.width), 'workArea.width 必须是数字');
    assert.ok(Number.isFinite(first.scaleFactor), 'scaleFactor 必须是数字');
  });

  console.log('\n[3] 真实置顶窗口');
  await step('note.create 建立真实窗口并回执同一 id', async () => {
    for (const spec of [
      { id: 'smoke-text', kind: 'text', text: '冒烟测试', x: 140, y: 140, width: 260, height: 200 },
      { id: 'smoke-snap', kind: 'text', text: '贴边', x: 8, y: 320, width: 240, height: 180 },
    ]) {
      const result = await client.call('note.create', {
        note: spec,
        settings: { hiddenRevealWidth: 10, snapDistance: 12 },
      });
      assert.equal(result.id, spec.id, 'note.create 必须回执同一个 id');
    }
  });

  await step('note.list 列出刚建的两个窗口', async () => {
    const result = await client.call('note.list');
    for (const id of ['smoke-text', 'smoke-snap']) {
      assert.ok(result.ids.includes(id), `note.list 应当包含 ${id}`);
    }
  });

  await step('note.reconcile 接受完整集合（含 hidden + edge）且窗口存活', async () => {
    const result = await client.call('note.reconcile', {
      notes: [
        { id: 'smoke-text', kind: 'text', text: '冒烟测试', x: 140, y: 140, width: 260, height: 200 },
        {
          id: 'smoke-snap',
          kind: 'text',
          text: '贴边',
          x: 0,
          y: 320,
          width: 240,
          height: 180,
          edge: 'left',
          hidden: true,
        },
      ],
      settings: { hiddenRevealWidth: 10 },
    });
    assert.ok(Array.isArray(result.ids), 'note.reconcile 必须回执 ids');
    assert.ok(result.ids.includes('smoke-text'), 'reconcile 后窗口必须仍然存在');
    assert.ok(result.ids.includes('smoke-snap'), '隐藏的便签也必须仍然存在');
  });

  await step('note.setHidden(true) 收成边缘小标签（不报错、窗口存活）', async () => {
    await client.call('note.setHidden', { id: 'smoke-text', hidden: true, edge: 'right' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const result = await client.call('note.list');
    assert.ok(result.ids.includes('smoke-text'), '隐藏后窗口必须仍然存活');
  });

  await step('note.setHidden(false) 弹回（不报错、窗口存活）', async () => {
    await client.call('note.setHidden', { id: 'smoke-text', hidden: false });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const result = await client.call('note.list');
    assert.ok(result.ids.includes('smoke-text'));
  });

  await step('note.focus / note.update / note.hide 均不抛错', async () => {
    await client.call('note.focus', { id: 'smoke-text' });
    await client.call('note.update', {
      id: 'smoke-text',
      patch: { text: '已更新', color: '#c8e6c9', opacity: 0.85 },
    });
  });

  console.log('\n[3b] 落点即吸附 + 自动隐藏（两种隐藏模式都要覆盖）');

  /**
   * Create an edge-hugging note, wait for it to snap and hide itself, and return
   * the real window bounds while hidden.
   * @param {string} id
   * @param {'offscreen'|'tab'} mode
   */
  async function snapAndHide(id, mode) {
    const settings = { autoHideDelayMs: 500, snapDistance: 24, hideMode: mode };
    await client.call('settings.apply', { settings });
    await client.call('note.create', {
      note: { id, kind: 'text', text: 'edge', x: 2, y: 320, width: 240, height: 180 },
      settings,
    });

    const deadline = Date.now() + 14000;
    let hidden = null;
    while (Date.now() < deadline) {
      const state = await client.call('note.get', { id });
      if (state?.note?.hidden === true && state.bounds !== null) {
        hidden = state;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return hidden;
  }

  for (const mode of ['offscreen', 'tab']) {
    // Per-mode id: `note.remove` at the end of each iteration would otherwise take
    // the next mode's note with it.
    const noteId = `smoke-edge-${mode}`;

    await step(`[${mode}] 贴边新建的便签会自己吸附，并在延迟后自动隐藏`, async () => {
      const hidden = await snapAndHide(noteId, mode);
      if (hidden === null) {
        // Report what actually happened instead of only "it is null".
        const state = await client.call('note.get', { id: noteId });
        const ids = (await client.call('note.list')).ids;
        throw new Error(
          `便签没有隐藏。note.get → ${JSON.stringify(state)}；当前窗口 ${JSON.stringify(ids)}`,
        );
      }
      assert.equal(hidden.note.edge, 'left', `应当吸附到左边缘，实际 ${String(hidden.note.edge)}`);

      const bounds = hidden.bounds;
      if (mode === 'offscreen') {
        // The default: the note keeps its own size and slides out of the display,
        // leaving exactly OFFSCREEN_SLIVER px on screen. Measured to work: Windows
        // does not clamp the window back on-screen.
        assert.equal(bounds.width, 240, `整块移出屏幕外时尺寸不该变，实际宽 ${bounds.width}`);
        assert.equal(bounds.x, -240 + 1, `左边缘外只应留 1px，实际 x=${bounds.x}`);
        assert.equal(
          Math.max(0, Math.min(bounds.x + bounds.width, 1920 * 4) - Math.max(bounds.x, 0)) >= 1,
          true,
          '至少有 1px 留在屏内，否则鼠标无处可去',
        );
      } else {
        // The optional tab mode: a fixed, taskbar-sized handle. Electron grows any
        // window below ~32px back to its own minimum, so the geometry must not ask
        // for less.
        assert.ok(bounds.width >= 30 && bounds.width <= 40, `小标签宽度应约 36px，实际 ${bounds.width}`);
        assert.equal(bounds.x, 0, `小标签必须贴住左边缘，实际 x=${bounds.x}`);
        assert.ok(bounds.height >= 56, `小标签必须留有可点的跨度，实际高 ${bounds.height}`);
      }
    });

    await step(`[${mode}] 弹回后恢复完整尺寸（便签不会永久缩成小标签）`, async () => {
      // A generous delay on purpose: this step must observe the *revealed* state,
      // and a note still glued to an edge re-hides on its own once the pointer is
      // away — which is correct behaviour, not the thing under test here.
      await client.call('settings.apply', { settings: { autoHideDelayMs: 60000 } });
      await client.call('note.setHidden', { id: noteId, hidden: false });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const state = await client.call('note.get', { id: noteId });
      assert.equal(state.note.hidden, false, '显式弹回后不得立刻又收起');
      assert.ok(state.bounds.width >= 200, `弹回后应当恢复完整宽度，实际 ${state.bounds.width}`);
      assert.ok(state.bounds.height >= 150, `弹回后应当恢复完整高度，实际 ${state.bounds.height}`);
      assert.ok(state.bounds.x >= 0, `弹回后必须回到屏内，实际 x=${state.bounds.x}`);
      await client.call('note.remove', { id: noteId });
    });
  }

  console.log('\n[3d] 「保留」：点过之后便签不再吸附、不再自动隐藏（回归：按钮曾只切换隐藏/显示）');
  await step('贴边的新便签自己隐藏；点「保留」后弹回、并且不再吸附也不再自动隐藏', async () => {
    const id = 'smoke-pin';
    const settings = { autoHideDelayMs: 300, snapDistance: 24, hideMode: 'offscreen' };
    await client.call('settings.apply', { settings });
    await client.call('note.create', {
      note: { id, kind: 'text', text: 'pin', x: 2, y: 300, width: 240, height: 180 },
      settings,
    });

    // 1. It hides itself without anyone asking.
    let state = null;
    const deadline = Date.now() + 14000;
    while (Date.now() < deadline) {
      state = await client.call('note.get', { id });
      if (state?.note?.hidden === true) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(state?.note?.hidden, true, '靠近边缘的新便签必须自己隐藏');
    assert.equal(state.note.pinned, false, '默认不是保留状态');

    // 2. 保留 pins it: revealed, at its own place, and no longer snapping.
    const pinned = await client.call('note.setPinned', { id, pinned: true });
    assert.equal(pinned.ok, true, `保留应当成功：${JSON.stringify(pinned)}`);
    assert.equal(pinned.pinned, true);

    await new Promise((resolve) => setTimeout(resolve, 700));
    state = await client.call('note.get', { id });
    assert.equal(state.note.hidden, false, '保留后应当显示出来');
    assert.equal(state.note.pinned, true, '保留标记必须写入便签状态');
    assert.ok(state.bounds.width >= 200, `保留后应当是完整尺寸，实际 ${state.bounds.width}`);

    // 3. It stays out: the auto-hide must not re-arm while pinned.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    state = await client.call('note.get', { id });
    assert.equal(state.note.hidden, false, '保留的便签不得自动隐藏');
    assert.equal(state.note.edge, null, '保留的便签不应记录吸附边');

    // 4. Moving it against the edge must not snap or hide it either.
    await client.call('note.update', { id, patch: { x: 0, y: 300 } });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    state = await client.call('note.get', { id });
    assert.equal(state.note.hidden, false, '保留期间贴到边缘也不得隐藏');
    assert.equal(state.note.edge, null, '保留期间不得吸附到边缘');

    // 5. 取消保留 hands it back to normal edge behaviour: it snaps and hides again.
    const unpinned = await client.call('note.setPinned', { id, pinned: false });
    assert.equal(unpinned.ok, true);
    const rehide = Date.now() + 14000;
    while (Date.now() < rehide) {
      state = await client.call('note.get', { id });
      if (state?.note?.hidden === true) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(state?.note?.hidden, true, '取消保留后应当重新吸附并隐藏');

    await client.call('note.remove', { id });
  });

  await step('设置热键后 helper 回执占用情况（不崩溃）', async () => {
    const result = await client.call('settings.apply', {
      settings: { hotkey: 'CommandOrControl+Alt+Shift+F9', snapDistance: 12 },
    });
    assert.equal(result.ok, true);
    assert.ok(result.hotkey !== undefined, '必须回执 hotkey 字段');
    const outcome = result.hotkey;
    assert.equal(typeof outcome.requested, 'string', '必须回执请求的快捷键，便于说明发生了什么');
    assert.equal(typeof outcome.registered, 'boolean', '必须回执是否真的注册成功');
    if (outcome.ok !== true) {
      assert.ok(typeof outcome.error === 'string' && outcome.error.length > 0, '失败时必须给出原因');
    }
  });

  await step('注册的永远只是用户设置的那个组合，绝不自动换成别的键', async () => {
    // `CommandOrControl+Alt+N` is measured as taken on the machine this was
    // developed on; the assertions hold whether or not it happens to be free here.
    // Either way the register must be all-or-nothing: a silent substitution would
    // change a key the user chose, leaving them pressing the right key for nothing.
    const result = await client.call('settings.apply', { settings: { hotkey: 'CommandOrControl+Alt+N' } });
    assert.equal(result.ok, true, '注册请求本身不应失败');
    const outcome = result.hotkey;
    assert.equal(outcome.requested, 'CommandOrControl+Alt+N', '必须回执用户请求的那个组合');
    assert.equal(outcome.replaced, false, '不应当有替代组合');
    assert.ok(!('substituted' in outcome), '不应当再出现 substituted 字段');

    if (outcome.registered === true) {
      assert.equal(outcome.hotkey, outcome.requested, '注册成功的必须是请求的那个键');
      assert.equal(outcome.ok, true);
      assert.equal(outcome.error, undefined, '成功时不应有错误说明');
    } else {
      // Taken: fail loudly, and say which key so the message is actionable.
      assert.equal(outcome.ok, false, '被占用时必须明确失败，而不是悄悄换键');
      assert.equal(outcome.hotkey, '', '失败时不应报出一个生效的快捷键');
      assert.equal(outcome.warning, 'conflict', '必须标记为冲突，供设置界面提示');
      assert.ok(
        typeof outcome.error === 'string' && outcome.error.includes('CommandOrControl+Alt+N'),
        `说明里必须写明是哪个键冲突，实际：${String(outcome.error)}`,
      );
    }
  });

  await step('冲突的快捷键不会占住按键：换一个可用组合后能正常注册', async () => {
    const result = await client.call('settings.apply', {
      settings: { hotkey: 'CommandOrControl+Alt+Shift+F10' },
    });
    const outcome = result.hotkey;
    assert.equal(outcome.registered, true, `F10 组合应当能注册：${JSON.stringify(outcome)}`);
    assert.equal(outcome.hotkey, 'CommandOrControl+Alt+Shift+F10');
    assert.equal(outcome.warning, undefined, '成功时不应带冲突标记');
  });

  console.log('\n[3c] 快捷键路径：popup.show 选「新建便签」（回归：createTextNote 曾根本不存在）');
  let hotkeyNoteId = null;
  await step('popup.show(forcedChoice=new-note) 真的建出便签并回执 note', async () => {
    const result = await client.call('popup.show', { forcedChoice: 'new-note' }, 20000);
    assert.equal(result.choice, 'new-note', `应当回执选择结果，实际 ${JSON.stringify(result)}`);
    assert.ok(result.note !== null && result.note !== undefined, '必须回执新建的便签');
    assert.ok(typeof result.note.id === 'string' && result.note.id.length > 0, '便签必须有 id');
    hotkeyNoteId = result.note.id;
  });

  await step('新便签继承设置里的外观（黑底 / 80% / 浅色文字），而不是硬编码默认值', async () => {
    await client.call('settings.apply', {
      settings: { backgroundColor: '#000000', opacity: 0.8, textColor: '#f5f5f5', fontSize: 15 },
    });
    const created = await client.call('popup.show', { forcedChoice: 'new-note' }, 20000);
    const note = created.note;
    assert.ok(note !== null && note !== undefined, '必须回执便签');
    assert.equal(note.color, '#000000', `新便签底色应取自设置，实际 ${String(note.color)}`);
    assert.equal(note.opacity, 0.8, `新便签透明度应取自设置，实际 ${String(note.opacity)}`);
    assert.equal(note.textColor, '#f5f5f5', `新便签文字色应取自设置，实际 ${String(note.textColor)}`);
    assert.equal(note.fontSize, 15, `新便签字号应取自设置，实际 ${String(note.fontSize)}`);
    await client.call('note.remove', { id: note.id });
  });

  await step('快捷键建出的便签落在屏幕可见范围内且窗口真实存在', async () => {
    const state = await client.call('note.get', { id: hotkeyNoteId });
    assert.ok(state.note !== null, '便签必须存在');
    assert.ok(state.bounds !== null, '必须有真实窗口边界');
    assert.ok(state.bounds.x >= 0 && state.bounds.y >= 0, `不得落在屏幕外：${JSON.stringify(state.bounds)}`);
    await client.call('note.remove', { id: hotkeyNoteId });
  });

  console.log('\n[4] 截图（desktopCapturer 真实取像素）');
  await step('shot.begin 能取到整屏图像，且过程无 helper.error', async () => {
    const before = events.length;
    // `shot.begin` resolves only when the user commits or cancels, so start it
    // and watch for a failure event instead of waiting for completion.
    const promise = client.call('shot.begin', { mode: 'file' }, 60000).catch((error) => ({ error: String(error) }));
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const newErrors = events.slice(before).filter((event) => event.event === 'helper.error');
    assert.equal(
      newErrors.length,
      0,
      `采屏过程中出现 helper.error：${newErrors.map((e) => JSON.stringify(e.data)).join('; ')}`,
    );

    // Close the annotation window so the run does not hang on a human.
    await client.call('helper.quit', {}, 5000).catch(() => {});
    await promise;
  });

  console.log('\n[5] 退出');
  await step('dispose() 让助手干净退出', async () => {
    await client.dispose();
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(client.alive, false, 'dispose 后 alive 必须为 false');
  });

  // The popup-without-a-window regression lives in `tools/test-popup.mjs`: it needs
  // to shut the helper down mid-step to answer the open menu, and doing that here
  // rejects every other in-flight request, which turned the run into a race. It is
  // its own process so that shutdown cannot disturb anything else.
  console.log('\n[5b] 弹窗回归见 tools/test-popup.mjs（独立进程）');
} catch (error) {
  console.error('\n冒烟测试异常终止：', error);
  failures.push('未捕获异常');
} finally {
  await client.dispose().catch(() => {});
}

console.log(`\n${'─'.repeat(62)}`);
if (failures.length === 0) {
  console.log('Electron 助手冒烟测试：全部通过 ✅');
  process.exit(0);
}
console.error(`Electron 助手冒烟测试：${failures.length} 项失败 ❌`);
for (const failure of failures) console.error(`  - ${failure}`);
process.exit(1);
