/**
 * Prove the model-facing surface actually registers.
 *
 * This exists because the previous implementation **silently registered nothing**: it called
 * `ctx.inject(['tools'], (toolCtx) => toolCtx.tools.register(…))`, and an injected context does not
 * expose services as properties, so `toolCtx.tools` was `undefined`, a `try` turned the
 * `TypeError` into a `log.warn`, and the plugin shipped with no tools at all. Nothing failed
 * loudly — the tool was simply missing from the model's tool list, which no existing test noticed
 * because none of them checked that a tool had been registered.
 *
 * So this asserts the things that were silently false:
 *
 *   1. `inject` declares `tools`, so `ctx.tools` is available by construction;
 *   2. every tool definition is accepted and named as documented;
 *   3. each definition carries the `output` schema and `render` that DSH's `ToolDefinition` requires
 *      (a definition without them is accepted by some hosts and produces no readable result);
 *   4. `execute` returns lossless JSON — DSH raises
 *      `tool "…" returned invalid output: value is not lossless JSON` otherwise;
 *   5. the system-prompt section and the skill are registered, and neither throws.
 *
 * Usage: node tools/test-tool-registration.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/test-tool-registration
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { StickyStore } from '../lib/host/store.js';
import { StickyBridge } from '../lib/host/bridge.js';
import { AlarmService } from '../lib/host/alarms.js';

const dataDir = mkdtempSync(join(tmpdir(), 'sticky-tools-'));
const failures = [];
const noop = () => {};
const log = { info: noop, warn: noop, error: noop, debug: noop };

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

const store = new StickyStore({ dir: dataDir, log });
store.load();
store.updateSettings({ autoStartHelper: false, hotkey: '' });
const bridge = new StickyBridge({ store, dataDir, log });
const alarms = new AlarmService({ store, bridge, log });

/**
 * A context that behaves the way Cordis does for the parts this plugin uses.
 *
 * The important detail is what an `inject` callback receives. Real Cordis hands back a **child
 * context that does not carry the injected service as a property** — you reach the service with
 * `ctx.get(name)`. Modelling that faithfully is the whole point of this harness: an earlier version
 * put the services on the callback's context, which let the *original bug*
 * (`toolCtx.tools.register(...)`) pass here while failing in DSH. A test more permissive than
 * reality is worse than no test at all.
 */
function makeCtx(services, options = {}) {
  const effects = [];
  const warnings = [];

  const effect = (fn, label) => {
    effects.push(label ?? '(unlabelled)');
    const cleanup = fn();
    return typeof cleanup === 'function' ? cleanup : () => {};
  };

  function invokeInject(deps, cb) {
    const missing = deps.filter((dep) => services[dep] === undefined);
    if (missing.length > 0) {
      if (options.throwOnMissingInject === true) throw new Error(`missing service: ${missing.join(',')}`);
      return;
    }
    cb(child);
  }

  /** The child an `inject` callback gets: `get` and `effect`, and no service properties. */
  const child = {
    logger: { ...log, warn: (m) => warnings.push(String(m)) },
    get: (name) => services[name],
    effect,
    inject: (deps, cb) => invokeInject(deps, cb),
  };

  const ctx = {
    logger: { ...log, warn: (m) => warnings.push(String(m)) },
    get: (name) => services[name],
    // Declared services are reachable as properties on the *root* context — that is the `inject`
    // export contract, and how DSH's own plugins reach `ctx.tools`.
    tools: services.tools,
    effect,
    inject: (deps, cb) => invokeInject(deps, cb),
  };

  return { ctx, child, effects, warnings };
}

function makeServices() {
  const tools = {
    register(definition) {
      return () => {};
    },
  };
  const systemPrompt = {
    section(declaration) {
      return () => {};
    },
  };
  const skillsService = {
    register(declaration) {
      return () => {};
    },
  };
  return { tools, systemPrompt, skills: skillsService };
}

// Capture what actually got registered by wrapping the services.
const services = makeServices();
const captured = { tools: [], sections: [], skills: [] };
services.tools.register = (definition) => {
  captured.tools.push(definition);
  return () => {};
};
services.systemPrompt.section = (declaration) => {
  captured.sections.push(declaration);
  return () => {};
};
services.skills.register = (declaration) => {
  captured.skills.push(declaration);
  return () => {};
};

const module = await import('../lib/index.js');

/**
 * The smallest arguments each tool needs to produce a real answer rather than a validation error.
 *
 * Declared before the assertions run: a `const` in the module body is in the temporal dead zone
 * until its initialiser executes, so referencing this from an async step above its declaration
 * throws `Cannot access 'ARGS_FOR' before initialization` — which is what happened the first time.
 */
const ARGS_FOR = {
  sticky_notes_create: { text: '测试便签', title: '测试' },
  sticky_notes_read: { id: 'does-not-exist' },
  sticky_notes_update: { id: 'does-not-exist', text: 'x' },
  sticky_notes_delete: { id: 'does-not-exist' },
  sticky_notes_show: { id: 'does-not-exist' },
  sticky_notes_hide: { id: 'does-not-exist' },
  sticky_notes_alarm_set: { label: '测试闹钟', text: 'x', schedule: { kind: 'daily', time: '09:30' } },
  sticky_notes_alarm_delete: { id: 'does-not-exist' },
  sticky_notes_alarm_ring: { id: 'does-not-exist' },
};

try {
  await step('inject 声明了 tools（这样 ctx.tools 才由构造保证存在）', () => {
    assert.ok(Array.isArray(module.inject), 'inject 必须是数组');
    assert.ok(module.inject.includes('tools'), `inject 必须包含 tools，实际 ${JSON.stringify(module.inject)}`);
  });

  await step('apply() 在正常的 Cordis context 下注册工具、提示段和技能', () => {
    const harness = makeCtx(services);
    module.apply(harness.ctx);
    assert.equal(captured.tools.length > 0, true, `必须注册到工具，实际 ${captured.tools.length} 个`);
    assert.equal(captured.sections.length, 1, `必须注册一个系统提示段，实际 ${captured.sections.length}`);
    assert.equal(captured.skills.length, 1, `必须注册一个技能，实际 ${captured.skills.length}`);
    // And it must not have degraded.
    const bad = harness.warnings.filter((line) => /注册失败/.test(line));
    assert.deepEqual(bad, [], `不应有注册失败：${bad.join(' | ')}`);
  });

  await step('每个工具都有 name/description/parameters/output/execute', () => {
    for (const definition of captured.tools) {
      assert.equal(typeof definition.name, 'string', `name 缺失：${JSON.stringify(definition.name)}`);
      assert.ok(definition.name.length > 0, 'name 不能为空');
      assert.equal(typeof definition.description, 'string', `${definition.name} 缺 description`);
      assert.ok(definition.description.length > 10, `${definition.name} 的 description 太短`);
      assert.equal(typeof definition.parameters, 'object', `${definition.name} 缺 parameters`);
      assert.equal(typeof definition.execute, 'function', `${definition.name} 缺 execute`);
      // DSH's ToolDefinition declares `output` as required; without it a host may accept the
      // registration but render nothing the model can read.
      assert.equal(typeof definition.output, 'object', `${definition.name} 缺 output（ToolDefinition 要求）`);
      assert.equal(typeof definition.output.schema, 'object', `${definition.name} 的 output.schema 缺失`);
      assert.equal(typeof definition.output.render, 'function', `${definition.name} 的 output.render 缺失`);
    }
    console.log(`         注册了 ${captured.tools.length} 个工具：${captured.tools.map((t) => t.name).join(', ')}`);
  });

  await step('工具名符合约定：sticky_notes_ 前缀，且互不重复', () => {
    const names = captured.tools.map((definition) => definition.name);
    assert.equal(new Set(names).size, names.length, `工具名重复：${names.join(', ')}`);
    for (const name of names) {
      assert.ok(name.startsWith('sticky_notes_'), `${name} 必须以 sticky_notes_ 开头`);
      assert.ok(/^[a-z0-9_]+$/.test(name), `${name} 只能含小写字母、数字和下划线`);
    }
  });

  await step('每个工具都真的能执行，且输出是无损 JSON', async () => {
    // DSH rejects a tool whose result cannot be serialised, with an error the model sees as a
    // broken tool rather than a bug in the plugin.
    for (const definition of captured.tools) {
      // The arguments each tool needs to succeed; a tool that cannot be exercised this way is
      // still required to return a structured failure rather than throw.
      const args = ARGS_FOR[definition.name] ?? {};
      const value = await definition.execute(args, {});
      assert.equal(typeof value, 'object', `${definition.name} 必须返回对象`);
      assert.equal(typeof value.ok, 'boolean', `${definition.name} 的返回值必须有 ok 字段`);
      assert.equal(typeof value.text, 'string', `${definition.name} 的返回值必须有 text 字段`);
      assert.doesNotThrow(() => JSON.parse(JSON.stringify(value)), `${definition.name} 的返回值必须能序列化`);
      // The renderer must produce a ContentBlock[] — NOT a string.
      //
      // The registry never checks this: `snapshotProjection` only requires lossless JSON, so a
      // string sails through registration, through projection, and then breaks a consumer that
      // calls `.some(…)` on `result.content`. That shipped once, and produced
      // `content.some is not a function` on **every** call while the action itself still worked —
      // which reads as "the action succeeded but the reporting is broken", and was misdiagnosed as
      // a version mismatch.
      const rendered = definition.output.render(args, JSON.parse(JSON.stringify(value)));
      assert.ok(
        Array.isArray(rendered),
        `${definition.name} 的 render 必须返回 ContentBlock[]，实际 ${typeof rendered}`,
      );
      assert.ok(rendered.length > 0, `${definition.name} 的 render 不能返回空数组`);
      for (const block of rendered) {
        assert.equal(block?.type, 'text', `${definition.name} 的 render 只应产出 text block`);
        assert.equal(typeof block.text, 'string', `${definition.name} 的 text block 必须有 text 字符串`);
      }
    }
  });

  await step('textOutput 会把字符串 render 归一成 ContentBlock[]（防止再次引入同一个 bug）', async () => {
    // The fix for `content.some is not a function` relies on `textOutput` normalising whatever a
    // renderer returns. That normalisation is the one piece of the fix not covered by the loop
    // above — every real tool here returns a string from its default renderer, so it is exercised
    // only indirectly. Pinned explicitly, because "someone adds a tool with a custom render that
    // returns a string" is exactly how this regression would come back.
    const { textOutput } = await import('../lib/host/tools.js');

    const defaultRender = textOutput().render;
    const fromString = defaultRender({}, { text: 'hello' });
    assert.ok(Array.isArray(fromString), '默认 render 必须返回数组');
    assert.deepEqual(fromString, [{ type: 'text', text: 'hello' }], '默认 render 应当包成一个 text block');

    // A custom renderer that returns a bare string must still be coerced.
    const custom = textOutput({}, () => 'custom text').render;
    assert.deepEqual(custom({}, {}), [{ type: 'text', text: 'custom text' }], '自定义 render 返回字符串时必须被转换');

    // A custom renderer that already returns blocks must pass through untouched — DSH supports
    // multi-block results (text plus an image), so coercing would silently drop blocks.
    const blocks = [
      { type: 'text', text: 'a' },
      { type: 'image', attachment: { id: 'x' } },
    ];
    const passthrough = textOutput({}, () => blocks).render;
    assert.deepEqual(passthrough({}, {}), blocks, '已经返回 block 数组时必须原样通过');

    // A missing/odd `text` must not produce `undefined` inside a block, which would fail the
    // lossless-JSON snapshot with a much less obvious error.
    assert.deepEqual(defaultRender({}, {}), [{ type: 'text', text: '' }], '没有 text 时应当是空字符串');
    assert.deepEqual(defaultRender({}, { text: 42 }), [{ type: 'text', text: '42' }], '非字符串 text 应当被字符串化');
  });

  await step('参数声明是合法 JSON Schema（type/properties/required 自洽）', () => {
    for (const definition of captured.tools) {
      const schema = definition.parameters;
      assert.equal(schema.type, 'object', `${definition.name} 的 parameters.type 必须是 object`);
      assert.equal(typeof schema.properties, 'object', `${definition.name} 缺 properties`);
      for (const required of schema.required ?? []) {
        assert.ok(
          Object.hasOwn(schema.properties, required),
          `${definition.name} 的 required "${required}" 不在 properties 里`,
        );
      }
      // Every declared property must carry a description — the model reads these.
      for (const [key, node] of Object.entries(schema.properties)) {
        assert.equal(typeof node.type, 'string', `${definition.name}.${key} 缺 type`);
        assert.equal(typeof node.description, 'string', `${definition.name}.${key} 缺 description`);
      }
    }
  });

  await step('系统提示段和技能带上了实际内容', () => {
    const section = captured.sections[0];
    assert.equal(typeof section.name, 'string', '提示段必须有 name');
    assert.equal(typeof section.order, 'number', '提示段必须有 order');
    const text = section.text();
    assert.equal(typeof text, 'string', '提示段的 text 必须返回字符串');
    assert.ok(text.length > 200, `提示段太短，实际 ${text.length} 字`);
    // It must name the tools, or it cannot stop the model reaching for pwsh.
    for (const needle of ['sticky_notes_create', 'sticky_notes_list', 'sticky_notes_alarm_set']) {
      assert.ok(text.includes(needle), `提示段里应当提到 ${needle}`);
    }

    const skill = captured.skills[0];
    assert.equal(typeof skill.name, 'string', '技能必须有 name');
    assert.ok(skill.description.length > 10, '技能 description 太短');
    assert.ok(skill.whenToUse.length > 10, '技能 whenToUse 太短');
    assert.equal(typeof skill.content, 'string', '技能必须有 content');
    assert.ok(skill.content.length > 200, '技能 content 太短');
  });

  await step('apply() 在一个不给任何服务的 context 下仍然不抛异常', () => {
    // The old failure was a swallowed throw; the requirement is that a missing optional service
    // never takes the plugin down. `tools` is declared, but `apply` must still not explode when it
    // is absent — DSH marks an entry FAILED when an apply callback throws.
    assert.doesNotThrow(() => module.apply(makeCtx({}).ctx), 'apply 在空 context 下抛了异常');
  });
} catch (error) {
  console.error('\n工具注册测试异常终止：', error);
  failures.push('未捕获异常');
} finally {
  alarms.dispose();
  await bridge.dispose().catch(() => {});
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(62)}`);
if (failures.length === 0) {
  console.log('模型工具注册测试：全部通过 ✅');
  process.exit(0);
}
console.error(`模型工具注册测试：${failures.length} 项失败 ❌`);
for (const failure of failures) console.error(`  - ${failure}`);
process.exit(1);
