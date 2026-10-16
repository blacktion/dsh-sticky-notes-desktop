/**
 * Verify the settings page's "is there a newer version?" check.
 *
 * ## What is actually risky here
 *
 * Not the happy path — that is one `fetch`. The risk is every way it can go wrong on a real machine: the
 * registry is unreachable, a proxy answers with HTML, the response is a 500, the request hangs. A
 * settings page must still render in all of those cases, so each one is exercised against a **local stub
 * server** rather than the real registry, which cannot be made to fail on demand.
 *
 * Version ordering is checked here too, because it is the part that silently produces a wrong answer:
 * comparing `0.10.0` with `0.9.0` as strings says the wrong thing, and a prerelease must never be
 * offered as an upgrade.
 *
 * Usage: node tools/test-version-check.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/test-version-check
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createVersionChecker } from '../lib/host/registry.js';
import { isNewerVersion, parseVersion } from '../lib/host/version.js';

const failures = [];
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`  [通过] ${label}`);
  } catch (error) {
    console.error(`  [失败] ${label}`);
    console.error(`         ${error instanceof Error ? error.message : String(error)}`);
    failures.push(label);
  }
};

// ---------------------------------------------------------------------------------------------
// Version ordering.
// ---------------------------------------------------------------------------------------------
console.log('=== 版本比较（字符串比较会在这里出错） ===');

await check('数值段按数字比较，不是按字符串', () => {
  assert.equal(isNewerVersion('0.10.0', '0.9.0'), true, '0.10.0 比 0.9.0 新');
  assert.equal(isNewerVersion('0.9.0', '0.10.0'), false, '0.9.0 不比 0.10.0 新');
  assert.equal(isNewerVersion('1.0.0', '0.99.99'), true, '1.0.0 更大');
});

await check('patch 级与相同版本', () => {
  assert.equal(isNewerVersion('0.1.1', '0.1.0'), true);
  assert.equal(isNewerVersion('0.1.0', '0.1.0'), false, '相同版本不算有更新');
});

await check('预发布版绝不作为升级提示', () => {
  assert.equal(isNewerVersion('0.2.0-rc.1', '0.1.0'), false, '预发布不应提示升级');
  assert.equal(isNewerVersion('1.0.0-beta', '0.1.0'), false);
  // 已经用着预发布版的人，看到更新的预发布版是合理的
  assert.equal(isNewerVersion('0.2.0-rc.2', '0.2.0-rc.1'), true);
});

await check('容忍 v 前缀、两位版本号、build 元数据', () => {
  assert.equal(isNewerVersion('v0.2.0', '0.1.0'), true);
  assert.equal(isNewerVersion('0.1', '0.0.9'), true, '0.1 应视作 0.1.0');
  assert.equal(isNewerVersion('0.2.0+build.5', '0.1.0'), true, 'build 元数据不影响比较');
});

await check('看不懂的版本一律返回 false（不猜）', () => {
  for (const bad of ['latest', 'x.y.z', '', null, undefined, 42, {}, '0.1.0.0', '0.1.x']) {
    assert.equal(isNewerVersion(bad, '0.1.0'), false, `${JSON.stringify(bad)} 应返回 false`);
  }
  assert.equal(isNewerVersion('0.2.0', null), false, '当前版本未知时不应提示');
});

await check('parseVersion 的形态符合预期', () => {
  assert.deepEqual(parseVersion('1.2.3'), { parts: [1, 2, 3], prerelease: '' });
  assert.deepEqual(parseVersion('1.2'), { parts: [1, 2, 0], prerelease: '' });
  assert.deepEqual(parseVersion('1.2.3-rc.1'), { parts: [1, 2, 3], prerelease: 'rc.1' });
  assert.equal(parseVersion('nope'), null);
});

// ---------------------------------------------------------------------------------------------
// The checker, against a stub registry.
// ---------------------------------------------------------------------------------------------

/** Start a stub registry. `handler` decides what each request gets. */
async function withStubRegistry(handler, run) {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run({ registry: `http://127.0.0.1:${port}`, hits: () => hits });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const jsonReply = (body, status = 200) => (_req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

console.log('\n=== 检查器：正常响应 ===');

await check('发现新版本时 updateAvailable 为 true', async () => {
  await withStubRegistry(jsonReply({ 'dist-tags': { latest: '0.2.0' } }), async ({ registry }) => {
    const checker = createVersionChecker({ packageName: 'x', currentVersion: '0.1.0', registry });
    const result = await checker.check(true);
    assert.equal(result.ok, true);
    assert.equal(result.latest, '0.2.0');
    assert.equal(result.updateAvailable, true);
  });
});

await check('已是最新时 updateAvailable 为 false', async () => {
  await withStubRegistry(jsonReply({ 'dist-tags': { latest: '0.1.0' } }), async ({ registry }) => {
    const checker = createVersionChecker({ packageName: 'x', currentVersion: '0.1.0', registry });
    const result = await checker.check(true);
    assert.equal(result.ok, true);
    assert.equal(result.updateAvailable, false);
  });
});

await check('只请求了 latest 标签，没有多余的往返', async () => {
  await withStubRegistry(jsonReply({ 'dist-tags': { latest: '0.1.0' } }), async ({ registry, hits }) => {
    const checker = createVersionChecker({ packageName: 'x', currentVersion: '0.1.0', registry });
    await checker.check(true);
    assert.equal(hits(), 1, `应恰好 1 次请求，实际 ${hits()}`);
  });
});

console.log('\n=== 检查器：所有失败路径都必须返回 ok:false，且不抛异常 ===');

await check('404（本地/tgz 安装的包没发布）→ not-published', async () => {
  await withStubRegistry(jsonReply({ error: 'Not found' }, 404), async ({ registry }) => {
    const checker = createVersionChecker({ packageName: 'x', currentVersion: '0.1.0', registry });
    const result = await checker.check(true);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-published');
  });
});

await check('500 → http-500', async () => {
  await withStubRegistry(jsonReply({ error: 'boom' }, 500), async ({ registry }) => {
    const checker = createVersionChecker({ packageName: 'x', currentVersion: '0.1.0', registry });
    const result = await checker.check(true);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'http-500');
  });
});

await check('返回 HTML（代理拦截）→ 不抛异常', async () => {
  await withStubRegistry(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>blocked by proxy</html>');
    },
    async ({ registry }) => {
      const checker = createVersionChecker({ packageName: 'x', currentVersion: '0.1.0', registry });
      const result = await checker.check(true);
      assert.equal(result.ok, false, '非 JSON 响应必须被当作失败，而不是抛出去');
    },
  );
});

await check('缺 dist-tags → no-dist-tag', async () => {
  await withStubRegistry(jsonReply({ versions: {} }), async ({ registry }) => {
    const checker = createVersionChecker({ packageName: 'x', currentVersion: '0.1.0', registry });
    const result = await checker.check(true);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-dist-tag');
  });
});

await check('连不上（端口没人监听）→ network', async () => {
  const checker = createVersionChecker({
    packageName: 'x',
    currentVersion: '0.1.0',
    registry: 'http://127.0.0.1:1',
  });
  const result = await checker.check(true);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'network');
});

await check('请求挂住 → 超时后返回，不无限等待', async () => {
  await withStubRegistry(
    () => {
      /* never respond */
    },
    async ({ registry }) => {
      const checker = createVersionChecker({ packageName: 'x', currentVersion: '0.1.0', registry });
      const started = Date.now();
      const result = await checker.check(true);
      const elapsed = Date.now() - started;
      assert.equal(result.ok, false, '超时必须算失败');
      assert.equal(result.reason, 'timeout');
      assert.ok(elapsed < 15000, `应在超时后很快返回，实际等了 ${elapsed}ms`);
    },
  );
});

await check('没有 fetch 可用时不抛异常', async () => {
  const checker = createVersionChecker({
    packageName: 'x',
    currentVersion: '0.1.0',
    registry: 'http://127.0.0.1:1',
    fetchImpl: null,
  });
  const result = await checker.check(true);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-fetch');
});

console.log('\n=== 缓存：设置页反复打开不应反复打扰 npm ===');

await check('第二次 check 走缓存，不再请求', async () => {
  await withStubRegistry(jsonReply({ 'dist-tags': { latest: '0.2.0' } }), async ({ registry, hits }) => {
    const checker = createVersionChecker({ packageName: 'x', currentVersion: '0.1.0', registry });
    await checker.check();
    await checker.check();
    await checker.check();
    assert.equal(hits(), 1, `三次 check 应只请求 1 次，实际 ${hits()}`);
  });
});

await check('force=true 跳过缓存', async () => {
  await withStubRegistry(jsonReply({ 'dist-tags': { latest: '0.2.0' } }), async ({ registry, hits }) => {
    const checker = createVersionChecker({ packageName: 'x', currentVersion: '0.1.0', registry });
    await checker.check();
    await checker.check(true);
    assert.equal(hits(), 2, `强制检查应再请求一次，实际 ${hits()}`);
  });
});

await check('失败也要缓存，但更短（不会连续重试）', async () => {
  await withStubRegistry(jsonReply({ error: 'boom' }, 500), async ({ registry, hits }) => {
    const checker = createVersionChecker({ packageName: 'x', currentVersion: '0.1.0', registry });
    await checker.check();
    await checker.check();
    assert.equal(hits(), 1, `失败后立刻再查应命中缓存，实际请求 ${hits()} 次`);
  });
});

await check('并发 check 只发一次请求（在途合并）', async () => {
  await withStubRegistry(jsonReply({ 'dist-tags': { latest: '0.2.0' } }), async ({ registry, hits }) => {
    const checker = createVersionChecker({ packageName: 'x', currentVersion: '0.1.0', registry });
    const all = await Promise.all([checker.check(), checker.check(), checker.check()]);
    assert.equal(hits(), 1, `并发三次应只请求 1 次，实际 ${hits()}`);
    for (const r of all) assert.equal(r.ok, true);
  });
});

console.log(`\n${'─'.repeat(64)}`);
if (failures.length === 0) {
  console.log('版本检查测试：全部通过 ✅（含 404 / 500 / HTML / 超时 / 断网 / 缓存 / 并发）');
  process.exit(0);
}
console.error(`版本检查测试：${failures.length} 项失败 ❌`);
for (const f of failures) console.error(`  - ${f}`);
process.exit(1);
