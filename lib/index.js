/**
 * dsh-sticky-notes — host half.
 *
 * Registers:
 *   - a durable note/settings store on disk,
 *   - the Electron helper that owns the real always-on-top note windows,
 *   - an authenticated JSON surface the browser half consumes
 *     (sidebar notes list, settings page, "new note / screenshot" trigger).
 *
 * Crash-safety posture, in order of importance:
 *
 *   1. Nothing heavy is imported at module scope, and nothing spawns a process
 *      until {@link StickyBridge.start} is actually called.
 *   2. `apply` never throws. The whole body is wrapped, and every optional
 *      subsystem registers through its own try/catch, so one failure cannot
 *      remove the others.
 *   3. Optional services are reached with `ctx.get(...)` plus an `undefined`
 *      guard — never `ctx.<service>`, which throws when the service is absent.
 *   4. Every registration goes through `ctx.effect`, so HMR and unload release
 *      exactly what this plugin added.
 *   5. The Electron helper is strictly optional. If the runtime is missing or
 *      the child dies, the store, the list, the editor and the settings page all
 *      keep working; only the floating windows degrade, and the UI says why.
 *
 * @module dsh-sticky-notes
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { StickyBridge } from './host/bridge.js';
import { AlarmService } from './host/alarms.js';
import { installRoutes } from './host/routes.js';
import { StickyStore } from './host/store.js';
import { buildTools, USAGE_GUIDE } from './host/tools.js';

export const name = 'sticky-notes';

/**
 * The plugin's own version, read from its `package.json`.
 *
 * Read rather than written out as a constant so the number the settings page shows is the same one the
 * package actually carries — a hardcoded copy drifts the first time someone bumps the version and
 * forgets, which is precisely the situation where a version display is being trusted to be right.
 *
 * Failure is not fatal: an unreadable manifest leaves the version `null`, and the UI omits the row
 * rather than claiming a version it does not know.
 *
 * @returns {string|null}
 */
function readOwnVersion() {
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    return typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : null;
  } catch {
    return null;
  }
}

/** Resolved once at load: the manifest does not change while DSH is running. */
export const PLUGIN_VERSION = readOwnVersion();

/**
 * `tools` is a hard dependency, and that is deliberate.
 *
 * Everything else this plugin touches (`webServer`, `systemPrompt`, `skills`) is reached through
 * `ctx.get(...)` and degrades to "that feature is unavailable". The model tools are different: they
 * are the entire reason a conversation can create a note, and declaring them here means
 * `ctx.tools` is present by construction rather than by a `try` that can silently swallow a
 * `TypeError` — which is exactly how the previous version shipped with no tools at all.
 *
 * A host without the `tools` service simply will not load this plugin, which is honest: the panel
 * and settings would work, but the plugin's headline capability would not, and that is worth
 * surfacing rather than hiding.
 */
export const inject = ['tools'];

/**
 * Resolve the plugin's data directory.
 *
 * Mirrors `@deepseek-ai/dsh-home-paths`' layout without importing it: that
 * package is a peer of the DSH core, not of a third-party plugin, so depending
 * on it would make this plugin fail to load on a host that does not expose it.
 *
 * @returns {string}
 */
function resolveDataDir() {
  const home = process.env.DSH_HOME;
  if (typeof home === 'string' && home.length > 0) return join(home, 'sticky-notes');
  const userHome = process.env.USERPROFILE ?? process.env.HOME;
  if (typeof userHome === 'string' && userHome.length > 0) return join(userHome, '.dsh', 'sticky-notes');
  return join(process.cwd(), '.dsh-sticky-notes');
}

export function apply(ctx) {
  // A broken logger must never turn a contained failure into a fatal one.
  const rawLog = ctx.logger ?? null;
  const safeLog = (level, message) => {
    try {
      rawLog?.[level]?.(message);
    } catch {
      /* ignore */
    }
  };

  try {
    applyInner(ctx, safeLog);
  } catch (error) {
    // A throwing plugin callback marks this entry FAILED and injects noise into
    // the host log. Degrading to "loaded but inert" is strictly better.
    safeLog('error', `sticky-notes: 插件初始化失败，已停用：${String(error)}`);
  }
}

function applyInner(ctx, safeLog) {
  const log = {
    info: (message) => safeLog('info', message),
    warn: (message) => safeLog('warn', message),
    error: (message) => safeLog('error', message),
  };

  const dataDir = resolveDataDir();
  const store = new StickyStore({ dir: dataDir, log: (level, message) => log[level]?.(message) });
  store.load();

  const bridge = new StickyBridge({
    store,
    dataDir,
    log,
  });

  // ------------------------------------------------------------ alarm service
  //
  // Watches the clock in this process, so alarms come due as long as DSH is running.
  const alarms = new AlarmService({ store, bridge, log });
  bridge.onAlarmClosed((id) => {
    void alarms.dismiss(id).catch((error) => log.warn(`sticky-notes: 记录闹钟关闭失败：${String(error)}`));
  });
  bridge.onAlarmMoved((id, x, y) => {
    // Dragging a 试响 popup is how the user chooses its position, so it must be recorded.
    try {
      alarms.rememberPosition(id, x, y);
    } catch (error) {
      log.warn(`sticky-notes: 记录闹钟位置失败：${String(error)}`);
    }
  });
  try {
    alarms.start();
    // One pass immediately: an alarm that came due while DSH was closed is shown now rather
    // than up to a tick later.
    void alarms.tick().catch((error) => log.warn(`sticky-notes: 闹钟首次检查失败：${String(error)}`));
  } catch (error) {
    log.warn(`sticky-notes: 启动闹钟轮询失败：${String(error)}`);
  }

  // Release the helper and flush the index when the plugin unloads or DSH exits.
  ctx.effect(
    () => () => {
      try {
        alarms.dispose();
      } catch (error) {
        log.warn(`sticky-notes: 关闭闹钟失败：${String(error)}`);
      }
      try {
        store.close();
      } catch (error) {
        log.warn(`sticky-notes: 关闭存储失败：${String(error)}`);
      }
      void bridge.dispose().catch((error) => log.warn(`sticky-notes: 释放助手失败：${String(error)}`));
    },
    'sticky-notes: lifecycle',
  );

  // ------------------------------------------------------------ web surface
  try {
    installRoutes(ctx, store, bridge, {
      getConnection: () => ctx.get('connection'),
      alarms,
      version: PLUGIN_VERSION,
    });
  } catch (error) {
    log.warn(`sticky-notes: 路由注册失败：${String(error)}`);
  }

  // --------------------------------------------------------- helper startup
  //
  // Deferred: bringing up an Electron runtime is slow, and DSH must finish
  // loading its own UI first. A note that was hidden at a screen edge comes back
  // as its sliver via `note.reconcile`, without any user action.
  try {
    bridge.scheduleAutostart();
  } catch (error) {
    log.warn(`sticky-notes: 自动启动助手失败：${String(error)}`);
  }

  // --------------------------------------------------------------- model tools
  //
  // Small, read-mostly surface so "帮我记一条便签" works from the conversation.
  registerTools(ctx, store, bridge, alarms, log);

  log.info(`sticky-notes: 已加载，${store.listNotes().length} 个便签；数据目录 ${dataDir}`);
}

/**
 * Register the model-facing surface: the `sticky_notes_*` tools, a system-prompt section, and a skill.
 *
 * ## The bug this replaces
 *
 * This used to be `ctx.inject(['tools'], (toolCtx) => toolCtx.tools.register(…))`. An injected
 * context does **not** expose services as properties, so `toolCtx.tools` was `undefined`, the
 * surrounding `try` swallowed the `TypeError` into a `log.warn`, and the plugin shipped with **no
 * model tools at all**. Nothing failed loudly; the tool was simply absent from the model's tool
 * list, which is why asking another conversation to "use the sticky notes plugin" produced
 * improvised `pwsh` work instead of a note.
 *
 * The convention `tools` requires is the one DSH's own plugins use: declare it in the `inject`
 * export and reach it as `ctx.tools`. Registration is then *not* wrapped in a catch-all `try` —
 * a programming error here should be loud, because the failure mode of the old code was silence.
 *
 * Each registration is its own `ctx.effect`, so unload releases exactly what was added.
 */
function registerTools(ctx, store, bridge, alarms, log) {
  // --------------------------------------------------------------- the tools
  const definitions = buildTools({ store, bridge, alarms });
  for (const definition of definitions) {
    try {
      // `ctx.tools` is guaranteed by the `inject` export, so no optional-service dance is needed.
      ctx.effect(() => ctx.tools.register(definition), `sticky-notes: tool ${definition.name}`);
    } catch (error) {
      // Worth a warning: the UI still works without tools, but the model loses that operation.
      log.warn(`sticky-notes: 工具 ${definition.name} 注册失败：${String(error)}`);
    }
  }

  // ------------------------------------------------------- system prompt section
  //
  // Always present, deliberately short: it exists to stop the model reaching for `pwsh` when the
  // user asks for a note. The longer workflows live in the skill below, loaded on demand.
  //
  // Reached through `get`, not as a property of the injected context. That distinction is the whole
  // reason this file was rewritten: an `inject` callback receives a context that does **not** carry
  // the service as a property, so `promptCtx.systemPrompt` would be `undefined` — exactly as
  // `toolCtx.tools` was when this plugin shipped with no tools at all.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    try {
      const systemPrompt = promptCtx.get('systemPrompt');
      if (systemPrompt === undefined) return;
      promptCtx.effect(
        () =>
          systemPrompt.section({
            name: 'sticky-notes:usage',
            order: 131,
            text: () => USAGE_GUIDE,
          }),
        'sticky-notes: prompt section',
      );
    } catch (error) {
      log.warn(`sticky-notes: 系统提示段注册失败：${String(error)}`);
    }
  });

  // ------------------------------------------------------------------- the skill
  //
  // The same guide, offered as a skill so it can also be discovered by name rather than only being
  // read off the prompt. `source: 'runtime'` is what the service expects for a plugin-supplied
  // skill that is not a directory on disk.
  ctx.inject(['skills'], (skillCtx) => {
    try {
      const skills = skillCtx.get('skills');
      if (skills === undefined) return;
      skillCtx.effect(
        () =>
          skills.register({
            name: 'sticky-notes',
            // The trigger words MUST live in `description`.
            //
            // DSH shows the model a skill catalog of `name: description` only — `whenToUse` is
            // never rendered, and the description is truncated at 500 characters. So describing
            // *what this is* while putting *when to use it* in `whenToUse` produces a catalog entry
            // the model has no reason to open. The wording below deliberately leads with the
            // phrases a user actually says.
            description:
              '在桌面上建立、查看、移动、隐藏、删除置顶便签（真实的系统级悬浮窗口），以及设置到点自动弹窗的「便签闹钟」。' +
              '当用户说「记一下」「帮我记一条」「新建便签」「贴个便签」「便签上写…」「把便签收起来/调出来」「删掉那条便签」' +
              '「提醒我…」「到点提醒」「设个闹钟」「每天早上/工作日几点提醒我」，或提到桌面上那张便签时，用这个技能了解 sticky_notes_* 工具。',
            whenToUse:
              '当用户说"记一下""帮我记""新建便签""贴个便签""便签上写…""把便签收起来/拿出来""提醒我…""到点提醒""设个闹钟"，或提到桌面上那张便签时。',
            source: 'runtime',
            content: USAGE_GUIDE,
          }),
        'sticky-notes: skill',
      );
    } catch (error) {
      log.warn(`sticky-notes: 技能注册失败：${String(error)}`);
    }
  });
}

