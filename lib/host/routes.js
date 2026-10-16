/**
 * dsh-sticky-notes — the browser half's JSON surface.
 *
 * Raw web-server routes do not inherit the Connection authentication fence, so
 * every route here goes through `authenticatedWebRoutes`.
 *
 * Each handler answers even when the Electron helper is down: the browser half
 * must be able to list, edit and delete notes and change settings with no
 * floating windows available, and the response always carries the helper's
 * status so the UI can explain the degradation.
 *
 * @module dsh-sticky-notes/host/routes
 */
import { authenticatedWebRoutes, readJsonBody, sendJson, sendBytes } from './web.js';
import { existsSync, readFileSync } from 'node:fs';

export const ROUTE_PREFIX = '/plugins/dsh-sticky-notes-desktop';

/**
 * An optional screen coordinate: a finite number, or null — never a coerced zero.
 *
 * Deliberately duplicated from `store.js` rather than imported: it is three lines, and the
 * difference it makes is between "centred" and "top-left corner". `Number(null) === 0`, so the
 * plausible-looking guard `Number.isFinite(Number(value))` treats "absent" as the coordinate 0.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toCoord(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

/**
 * @param {object} ctx                       Cordis context (for `ctx.effect`)
 * @param {import('./store.js').StickyStore} store
 * @param {import('./bridge.js').StickyBridge} bridge
 * @param {object} options
 * @param {() => object|undefined} options.getConnection  `() => ctx.get('connection')`
 * @param {import('./alarms.js').AlarmService|null} [options.alarms]
 * @param {string|null} [options.version]  The plugin's own version, for the settings page to display.
 * @param {object|null} [options.versionChecker]  `createVersionChecker(...)`, for the update hint.
 */
export function installRoutes(ctx, store, bridge, options) {
  let registered = false;
  const alarms = options.alarms ?? null;
  const version = typeof options.version === 'string' && options.version.length > 0 ? options.version : null;
  const versionChecker = options.versionChecker ?? null;
  /** The plugin's identity, sent with every settings payload so the page can show what it is running. */
  const about = { name: 'dsh-sticky-notes-desktop', version };

  const registerAll = () => {
    if (registered) return;
    const raw = ctx.get('webServer') ?? ctx.get('httpServer');
    if (raw === undefined) return;
    registered = true;

    const server = authenticatedWebRoutes(raw, options.getConnection);
    const route = (definition) => ctx.effect(() => server.register(definition), `sticky-notes: ${definition.path}`);
    const body = (req, res) => readJsonBody(req, res);
    const query = (req) => new URL(req.url ?? '/', 'http://x').searchParams;

    /** Everything the browser half needs for one render. */
    const snapshot = async () => ({
      notes: store.listNotes(),
      // Alarms come from the service, not the store: each one carries its derived
      // "next fire" and "ringing now" state, which the store has no opinion about.
      alarms: alarms === null ? [] : alarms.list(),
      settings: store.getSettings(),
      helper: bridge.status,
      about,
    });

    // ------------------------------------------------------------------ state
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/state`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        sendJson(res, 200, await snapshot());
      },
    });

    // ------------------------------------------------------------------ notes
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/notes`,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          sendJson(res, 200, { notes: store.listNotes() });
          return;
        }

        if (req.method === 'POST') {
          const payload = await body(req, res);
          if (payload === null) return;
          // A new note inherits the user's configured appearance. Without this,
          // the panel's "new note" button would produce a note that ignores the
          // colours chosen in settings.
          const settings = store.getSettings();
          const note = store.upsertNote({
            color: settings.backgroundColor,
            opacity: settings.opacity,
            textColor: settings.textColor,
            fontSize: settings.fontSize,
            ...payload,
          });
          // Best-effort: the note is persisted either way, and a missing helper
          // is reported through `helper` rather than as a failed write.
          //
          // Create the window with `activate` first: the user asked for a new note, so
          // it has to come up able to receive keystrokes. `openNote` alone would only
          // re-surface an existing window and never convey that intent.
          await bridge.createNote(note);
          const opened = await bridge.openNote(note.id);
          sendJson(res, 200, { note, opened, helper: bridge.status });
          return;
        }

        if (req.method === 'PATCH') {
          const payload = await body(req, res);
          if (payload === null) return;
          const id = String(payload.id ?? '');
          const note = store.updateNote(id, payload.patch ?? {});
          if (note === null) {
            sendJson(res, 404, { error: '便签不存在' });
            return;
          }
          await bridge.pushNote(id, payload.patch ?? {});
          sendJson(res, 200, { note });
          return;
        }

        if (req.method === 'DELETE') {
          const id = query(req).get('id') ?? '';
          const existed = store.getNote(id) !== null;
          await bridge.closeNote(id);
          const removed = store.deleteNote(id);
          sendJson(res, existed ? 200 : 404, { removed, notes: store.listNotes() });
          return;
        }

        sendJson(res, 405, { error: 'method not allowed' });
      },
    });

    /** Open (or bring forward) a note's floating window. */
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/notes/open`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const payload = await body(req, res);
        if (payload === null) return;
        const result = await bridge.openNote(String(payload.id ?? ''));
        sendJson(res, 200, { ...result, helper: bridge.status });
      },
    });

    /**
     * Keep a note on screen, or let it go back to hiding at the edge.
     *
     * The note window's own 「保留」 button drives the same preference through the
     * helper; this route is how the list does it. Both persist the flag, so the two
     * entry points cannot disagree.
     */
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/notes/pin`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const payload = await body(req, res);
        if (payload === null) return;
        const result = await bridge.setPinned(String(payload.id ?? ''), payload.pinned === true);
        sendJson(res, result.ok === true ? 200 : 404, {
          ...result,
          notes: store.listNotes(),
          helper: bridge.status,
        });
      },
    });

    /** Force a note hidden at its edge, or bring it back. */
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/notes/hide`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const payload = await body(req, res);
        if (payload === null) return;
        const id = String(payload.id ?? '');
        const hidden = payload.hidden === true;
        const result = await bridge.setHidden(id, hidden);
        // Record the intent even when the helper is unavailable, so the state is
        // correct the next time it starts.
        if (result.ok !== true) store.updateNote(id, { hidden });
        sendJson(res, 200, { ...result, helper: bridge.status });
      },
    });

    // --------------------------------------------------------------- settings
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/settings`,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          sendJson(res, 200, { settings: store.getSettings(), helper: bridge.status, about });
          return;
        }
        if (req.method === 'PATCH' || req.method === 'POST') {
          const payload = await body(req, res);
          if (payload === null) return;
          const settings = store.updateSettings(payload);
          store.flush();
          const applied = await bridge.applySettings(settings);
          sendJson(res, 200, { settings, applied, helper: bridge.status, about });
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
      },
    });

    // ---------------------------------------------------------------- version
    //
    // A separate route rather than part of `/settings`, because this one can take seconds: it talks to
    // npm over the network. Folding it into `/settings` would make the whole page wait on the registry,
    // and a machine with no outbound access would see the settings page itself fail to load. The page
    // renders from `/settings` immediately and fills this in when it answers.
    //
    // `?force=1` is what the "check now" control sends; without it the host answers from its cache.
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/version-check`,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        if (versionChecker === null) {
          sendJson(res, 200, { ok: false, reason: 'unavailable' });
          return;
        }
        const force = /[?&]force=1\b/.test(String(req.url ?? ''));
        sendJson(res, 200, await versionChecker.check(force));
      },
    });

    // ---------------------------------------------------------------- capture
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/capture`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const payload = await body(req, res);
        if (payload === null) return;
        const result = await bridge.capture(payload?.mode === 'file' ? 'file' : 'note');
        sendJson(res, 200, { ...result, helper: bridge.status });
      },
    });

    // ------------------------------------------------------------------ popup
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/popup`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const result = await bridge.showPopup();
        sendJson(res, 200, { ...result, helper: bridge.status });
      },
    });

    // ----------------------------------------------------------------- helper
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/helper`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        const runtime = bridge.probeRuntime();
        // Snapshotted once: `bridge.status` is a getter that rebuilds the object on each read, so
        // reading it repeatedly invites reporting a status that contradicts itself.
        const status = bridge.status;
        const listed = await bridge.displays();
        const displays = Array.isArray(listed?.displays) ? listed.displays : [];

        /**
         * Whether the helper is answering, not merely recorded as started.
         *
         * `running` is the host's own bookkeeping, and it stays true for a helper that has wedged
         * or that was started from an older build of the plugin. The displays query is a real
         * round trip, so it separates "we believe it is running" from "it replied" — which is the
         * entire point of showing a status.
         */
        const responsive = status.running === true && displays.length > 0;
        const state = responsive ? 'running' : status.running === true ? 'unresponsive' : 'stopped';

        sendJson(res, 200, {
          ...status,
          runtime,
          displays,
          responsive,
          state,
          stateText:
            state === 'running'
              ? `服务正在运行（${displays.length} 个显示器）`
              : state === 'unresponsive'
                ? '服务进程在，但没有响应（建议重启服务）'
                : '服务未运行',
        });
      },
    });

    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/helper/start`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const status = await bridge.start();
        sendJson(res, 200, { ...status });
      },
    });

    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/helper/stop`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const status = await bridge.stop();
        sendJson(res, 200, { ...status });
      },
    });

    /**
     * Stop and start the helper.
     *
     * A restart is the fix for the one state nothing else reaches: a helper that is running but no
     * longer answering, or one started before the plugin was updated and therefore still running
     * old code. Stopping alone would leave the feature off, so the two are a single action.
     */
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/helper/restart`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        await bridge.stop();
        // A brief pause, not ceremony: the old helper holds `helper.lock` until it has really
        // exited, and starting into a lock still held fails with "another helper is using this
        // directory" — which reads as "the restart broke it".
        await new Promise((resolve) => setTimeout(resolve, 600));
        const status = await bridge.start();
        sendJson(res, 200, { ...status });
      },
    });

    /**
     * Serve a note's stored PNG.
     *
     * This exists because the browser half cannot read `file://` paths, and the
     * floating note window reads the same bytes straight off disk.
     */
    // ----------------------------------------------------------------- alarms
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/alarms`,
      handler: async (req, res) => {
        if (alarms === null) return sendJson(res, 503, { error: '闹钟服务不可用' });

        if (req.method === 'GET') {
          sendJson(res, 200, { alarms: alarms.list() });
          return;
        }

        if (req.method === 'POST') {
          const payload = await body(req, res);
          if (payload === null) return;
          // Creating is the only thing that must not be reachable without a service: a
          // stored alarm that can never ring is worse than a refused one.
          const alarm = store.upsertAlarm(payload);
          sendJson(res, 200, { alarm, alarms: alarms.list() });
          return;
        }

        if (req.method === 'PATCH') {
          const payload = await body(req, res);
          if (payload === null) return;
          const id = String(payload.id ?? '');
          const alarm = store.updateAlarm(id, payload.patch ?? payload);
          if (alarm === null) return sendJson(res, 404, { error: '闹钟不存在' });
          sendJson(res, 200, { alarm, alarms: alarms.list() });
          return;
        }

        if (req.method === 'DELETE') {
          const id = query(req).get('id') ?? '';
          if (id.length === 0) return sendJson(res, 400, { error: 'missing id' });
          // Close first: an alarm deleted while ringing must not leave its popup behind.
          await bridge.closeAlarm(id).catch(() => {});
          const removed = store.deleteAlarm(id);
          store.flushSoon();
          sendJson(res, removed ? 200 : 404, { removed, alarms: alarms.list() });
          return;
        }

        sendJson(res, 405, { error: 'method not allowed' });
      },
    });

    /**
     * Ring an alarm now, ignoring its schedule.
     *
     * The editor's 试响 button, and the way a popup's position is chosen: drag it where you
     * want it and the position is recorded. It must not consume a `once` alarm, so this goes
     * through the service's `preview` rather than the scheduler.
     *
     * With no `id` it previews the draft in the request body — which is what lets the
     * 「新建闹钟」 form 试响 before there is anything saved to preview.
     */
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/alarms/ring`,
      handler: async (req, res) => {
        if (alarms === null) return sendJson(res, 503, { error: '闹钟服务不可用' });
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const payload = await body(req, res);
        if (payload === null) return;

        const id = String(payload.id ?? '');
        const result =
          id.length > 0
            ? await alarms.preview(id)
            : await alarms.previewDraft({
                label: typeof payload.label === 'string' ? payload.label : '',
                kind: payload.kind === 'image' ? 'image' : 'text',
                text: typeof payload.text === 'string' ? payload.text : '',
                image: typeof payload.image === 'string' ? payload.image : null,
                // A draft carries its position too, so previewing again keeps the place the
                // user just chose instead of snapping back to the centre. Guarded against the
                // `Number(null) === 0` trap — see `toCoord` in store.js.
                x: toCoord(payload.x),
                y: toCoord(payload.y),
              });

        sendJson(res, result.ok === true ? 200 : 404, {
          ...result,
          // Handed back so the editor can adopt the position the user just dragged to.
          position: alarms.draftPosition,
          alarms: alarms.list(),
        });
      },
    });

    /**
     * The position a popup was dragged to.
     *
     * Recorded from the helper's `alarm.moved`, which is the mechanism that turns 试响 into a
     * position picker. Reported by the helper rather than inferred from a drag the host cannot
     * see, so it also works for a draft that has no record yet.
     */
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/alarms/position`,
      handler: async (req, res) => {
        if (alarms === null) return sendJson(res, 503, { error: '闹钟服务不可用' });
        if (req.method === 'GET') {
          sendJson(res, 200, { position: alarms.draftPosition });
          return;
        }
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const payload = await body(req, res);
        if (payload === null) return;
        sendJson(res, 200, alarms.rememberPosition(String(payload.id ?? ''), payload.x, payload.y));
      },
    });

    /** Dismiss an alarm's popup (the panel's 「关闭响铃」). */
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/alarms/dismiss`,
      handler: async (req, res) => {
        if (alarms === null) return sendJson(res, 503, { error: '闹钟服务不可用' });
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const payload = await body(req, res);
        if (payload === null) return;
        const id = String(payload.id ?? '');
        await bridge.closeAlarm(id).catch(() => {});
        sendJson(res, 200, { ...(await alarms.dismiss(id)), alarms: alarms.list() });
      },
    });

    /** Open the native picker and return the chosen image path (or null when cancelled). */
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/alarms/pick-image`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const result = await bridge.pickAlarmImage();
        sendJson(res, result.ok === false ? 503 : 200, result);
      },
    });

    /** Serve an alarm's image, the same way note images are served. */
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/alarm-image`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        const id = query(req).get('id') ?? '';
        if (id.length === 0) return sendJson(res, 400, { error: 'missing id' });
        const alarm = store.getAlarm(id);
        if (alarm === null || typeof alarm.image !== 'string') return sendJson(res, 404, { error: 'no image' });
        try {
          if (!existsSync(alarm.image)) return sendJson(res, 404, { error: 'image file missing' });
          sendBytes(res, 200, 'image/png', readFileSync(alarm.image));
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : 'read failed' });
        }
      },
    });

    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/image`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        const id = query(req).get('id') ?? '';
        if (id.length === 0) return sendJson(res, 400, { error: 'missing id' });
        const note = store.getNote(id);
        if (note === null || typeof note.image !== 'string') return sendJson(res, 404, { error: 'no image' });
        try {
          const path = note.image;
          if (!existsSync(path)) return sendJson(res, 404, { error: 'image file missing' });
          sendBytes(res, 200, 'image/png', readFileSync(path));
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : 'read failed' });
        }
      },
    });
  };

  // The web server may activate after this plugin, so retry on any of the
  // service signals DSH emits rather than giving up silently.
  const retry = () => {
    try {
      registerAll();
    } catch (error) {
      ctx.logger?.warn?.(`sticky-notes: 路由注册失败：${String(error)}`);
    }
  };

  retry();
  ctx.inject(['webServer'], retry);
}
