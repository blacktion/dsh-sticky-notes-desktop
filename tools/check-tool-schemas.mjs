/**
 * Validate every declared schema against the subset DSH actually enforces.
 *
 * `ctx.tools.register` runs `assertSupportedJsonSchema` over both `parameters` and
 * `output.schema`, and its rules are stricter than "is this valid JSON Schema": notably
 * **`additionalProperties` must be explicitly true or false on every object node**, `oneOf` may not
 * be combined with `type`, and `$ref`/`allOf`/`pattern`/`format`/numeric bounds are all rejected.
 *
 * A violation surfaces at registration time as a thrown `TypeError`, which — for a plugin that
 * registers inside a per-tool `try` — would quietly remove that one tool from the model's list. So
 * the schemas are checked here, in the test suite, rather than discovered in production.
 *
 * The allowed-node set below mirrors the documented subset; it is deliberately a whitelist so an
 * accidentally-invented keyword fails rather than being passed through.
 *
 * @module dsh-sticky-notes-desktop/tools/check-tool-schemas
 */
import assert from 'node:assert/strict';
import { StickyStore } from '../lib/host/store.js';
import { StickyBridge } from '../lib/host/bridge.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
/** Annotations DSH's subset allows alongside structure. */
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples']);
const STRUCTURAL = new Set(['type', 'properties', 'additionalProperties', 'items', 'required', 'enum', 'const', 'oneOf']);

/** Walk one schema node, collecting every violation. */
function validateNode(node, path, violations) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    violations.push(`${path}: 必须是一个对象`);
    return;
  }
  for (const key of Object.keys(node)) {
    if (!ANNOTATIONS.has(key) && !STRUCTURAL.has(key)) {
      violations.push(`${path}: 不允许的关键字 "${key}"（DSH 的 schema 子集不接受它）`);
    }
  }
  if (node.oneOf !== undefined) {
    if (node.type !== undefined) violations.push(`${path}: oneOf 不能与 type 同时出现`);
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) violations.push(`${path}: oneOf 至少要有两个分支`);
    (node.oneOf ?? []).forEach((branch, index) => validateNode(branch, `${path}.oneOf[${index}]`, violations));
  }
  if (node.type !== undefined && !TYPES.has(node.type)) {
    violations.push(`${path}: 未知的 type "${String(node.type)}"`);
  }
  if (node.type === 'object') {
    // The rule that is easiest to miss and fatal at registration time.
    if (node.additionalProperties === undefined) {
      violations.push(`${path}: object 节点必须显式声明 additionalProperties`);
    } else if (typeof node.additionalProperties !== 'boolean') {
      violations.push(`${path}: additionalProperties 必须是布尔值`);
    }
  }
  if (node.properties !== undefined) {
    if (node.type !== 'object') violations.push(`${path}: 有 properties 但 type 不是 object`);
    for (const [key, child] of Object.entries(node.properties)) {
      validateNode(child, `${path}.properties.${key}`, violations);
    }
  }
  if (node.items !== undefined) {
    if (node.type !== 'array') violations.push(`${path}: 有 items 但 type 不是 array`);
    validateNode(node.items, `${path}.items`, violations);
  }
  if (node.required !== undefined) {
    if (!Array.isArray(node.required) || node.required.some((name) => typeof name !== 'string')) {
      violations.push(`${path}: required 必须是字符串数组`);
    } else {
      for (const name of node.required) {
        if (node.properties === undefined || !Object.hasOwn(node.properties, name)) {
          violations.push(`${path}: required "${name}" 不在 properties 里`);
        }
      }
    }
  }
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) violations.push(`${path}: enum 不能为空`);
  }
}

const dataDir = mkdtempSync(join(tmpdir(), 'sticky-schema-'));
const noop = () => {};
const log = { info: noop, warn: noop, error: noop, debug: noop };
const store = new StickyStore({ dir: dataDir, log });
store.load();
const bridge = new StickyBridge({ store, dataDir, log });

let failed = false;
try {
  const { buildTools } = await import('../lib/host/tools.js');
  const tools = buildTools({ store, bridge, alarms: null });
  assert.ok(tools.length > 0, '应当至少有一个工具');

  for (const tool of tools) {
    const violations = [];
    validateNode(tool.parameters, `${tool.name}.parameters`, violations);
    validateNode(tool.output.schema, `${tool.name}.output.schema`, violations);
    if (violations.length > 0) {
      failed = true;
      console.error(`  [失败] ${tool.name}`);
      for (const violation of violations) console.error(`         ${violation}`);
    }
  }

  if (!failed) {
    console.log(`工具 schema 检查通过 ✅（${tools.length} 个工具，parameters 与 output.schema 都符合 DSH 的子集）`);
  }
} finally {
  await bridge.dispose().catch(() => {});
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
