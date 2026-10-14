/**
 * dsh-sticky-notes — Electron helper main process.
 *
 * Runs inside our OWN Electron runtime (spawned by `lib/host/runtime.js`), never
 * inside the DSH host, which is plain Node under `ELECTRON_RUN_AS_NODE=1`.
 * That separation is the whole point: it is the only way a DSH plugin can own a
 * real system-level always-on-top window.
 *
 * Transport: **newline-delimited JSON over a loopback TCP socket**, not stdio.
 * Electron's main process gives `process.stdin` no usable fd — the stream reports
 * `readable: true` yet `'end'` fires immediately and no byte ever arrives — so
 * `process.stdin` cannot carry requests. stdout *is* usable, which is how the
 * port and token are handed back to the host at startup.
 *
 *   electron → stdout:  {"ready":true,"port":52341,"token":"…"}
 *   host     → socket:  {"id":12,"method":"note.create","params":{…}}
 *   socket   → host:    {"id":12,"ok":true,"result":{…}}
 *   socket   → host:    {"event":"note.moved","data":{…}}
 *
 * Responsibilities:
 *   - one always-on-top window per note (notes.mjs),
 *   - edge snapping, slide-out auto-hide, and hover-to-reveal (notes.mjs),
 *   - the pointer-anchored "new note / screenshot" popup (popup.mjs),
 *   - the system-wide toggle hotkey (globalShortcut),
 *   - full-screen capture + the annotation window (capture.mjs).
 *
 * Failure posture: this process is disposable. If it dies, DSH must not notice
 * beyond "the floating notes stopped working", so every handler is wrapped and
 * every window failure is reported as an event rather than thrown at startup.
 *
 * @module dsh-sticky-notes/electron/main
 */
import { app, BrowserWindow, ipcMain, screen, globalShortcut, clipboard, nativeImage, ClipboardItem, dialog } from 'electron';
import { createServer } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';

import { NoteManager } from './notes.mjs';
import { PopupController, POPUP_ITEMS } from './popup.mjs';
import { CaptureController } from './capture.mjs';
import { AlarmWindows, DRAFT_ALARM_ID } from './alarm-windows.mjs';

// ---------------------------------------------------------------- transport ==

/** Connected host sockets. Normally exactly one; the client may reconnect. */
const peers = new Set();

/** Shared secret so another local process cannot drive our windows. */
const TOKEN = randomBytes(24).toString('hex');

/** Write one message to every connected host. */
function broadcast(message) {
  const line = `${JSON.stringify(message)}\n`;
  for (const socket of peers) {
    try {
      if (!socket.destroyed) socket.write(line);
    } catch {
      /* a dead peer is dropped on its own 'close' */
    }
  }
}

/** Push an unsolicited event to the host. */
function emit(event, data = {}) {
  broadcast({ event, data });
}

/**
 * Facts about this helper, folded into the handshake reply.
 *
 * `helper.ready` is also pushed as an event, but a push emitted before the host's
 * socket finishes connecting would be lost — and "did the helper actually come
 * up?" is exactly the question the host must never get wrong. Returning the same
 * payload from the handshake makes readiness a pull, not a race.
 */
function readyPayload() {
  let displays = 0;
  try {
    displays = screen.getAllDisplays().length;
  } catch {
    /* ignore */
  }
  return {
    version: process.versions.electron ?? 'unknown',
    displays,
    pid: process.pid,
    platform: process.platform,
  };
}

/**
 * Handle one request line.
 *
 * A malformed line is reported as an event rather than closing the connection:
 * a single bad frame should not cost the user their note windows.
 */
async function handleLine(line, reply) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    emit('helper.error', { message: '无法解析来自宿主机的消息' });
    return;
  }
  if (message === null || typeof message !== 'object' || typeof message.id !== 'number') return;
  try {
    const result = await dispatch(String(message.method ?? ''), message.params ?? {});
    reply({ id: message.id, ok: true, result: result === undefined ? {} : result });
  } catch (error) {
    reply({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Constant-time token comparison, tolerant of length mismatch. */
function tokenMatches(candidate) {
  if (typeof candidate !== 'string') return false;
  const expected = Buffer.from(TOKEN, 'utf8');
  const actual = Buffer.from(candidate, 'utf8');
  if (expected.length !== actual.length) return false;
  try {
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/**
 * Start the loopback RPC server and announce it on stdout.
 *
 * Port 0 lets the OS pick a free port, which avoids colliding with anything the
 * user already runs. Binding to 127.0.0.1 keeps it off the network entirely; the
 * token covers the remaining case of another local process guessing the port.
 *
 * @param {{ onRequest: (line: string, reply: (message: object) => void) => void }} options
 * @returns {Promise<number>} the bound port
 */
function startRpcServer(options) {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.setNoDelay(true);

      let buffer = '';
      let authorised = false;

      const reply = (message) => {
        try {
          if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
        } catch {
          /* ignore */
        }
      };

      socket.on('data', (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');
          if (line.length === 0) continue;

          if (!authorised) {
            // First frame must be the handshake.
            let hello = null;
            try {
              hello = JSON.parse(line);
            } catch {
              hello = null;
            }
            if (hello === null || hello.hello !== true || !tokenMatches(hello.token)) {
              reply({ ok: false, error: 'unauthorised' });
              try {
                socket.destroy();
              } catch {
                /* ignore */
              }
              return;
            }
            authorised = true;
            peers.add(socket);
            // The handshake reply doubles as the readiness report, so the host
            // never has to depend on catching a push event.
            reply({ ok: true, result: { authorised: true, ready: readyPayload() } });
            continue;
          }

          options.onRequest(line, reply);
        }
        if (buffer.length > 8 * 1024 * 1024) buffer = '';
      });

      socket.on('error', () => {
        peers.delete(socket);
      });
      socket.on('close', () => {
        peers.delete(socket);
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('RPC 服务器未能取得端口'));
        return;
      }
      resolve(address.port);
    });
  });
}

// ------------------------------------------------------------------- state ==

// Baseline before the host sends its stored settings. Kept in step with
// `DEFAULT_SETTINGS` in lib/host/store.js so a helper that starts before the host
// configures it still produces notes that look like the documented default.
let settings = {
  hotkey: 'CommandOrControl+Alt+S',
  backgroundColor: '#000000',
  opacity: 0.8,
  textColor: '#f5f5f5',
  fontSize: 14,
  snapDistance: 12,
  hideMode: 'offscreen',
  autoHideDelayMs: 1200,
  revealDelayMs: 120,
};

/** Data directory handed to us by the host; also where exported PNGs default. */
let dataDir = join(app.getPath('userData'), 'sticky-notes');

/**
 * Pointer position, with a test-only override.
 *
 * The real source is `screen.getCursorScreenPoint()`. Synthetic pointer movement
 * cannot be produced from a script, so the popup-dismissal rules — which are driven
 * by the pointer leaving the popup — would otherwise be untestable. Setting
 * `cursor.fixed` pins the position; clearing it restores the real cursor.
 *
 * @type {{x:number,y:number}|null}
 */
let fixedCursor = null;

/** Where the pointer is right now. */
function cursorPoint() {
  if (fixedCursor !== null) return { ...fixedCursor };
  return screen.getCursorScreenPoint();
}

let notes = null;
let popup = null;
let capture = null;
let alarms = null;

/**
 * Note: there is deliberately no `pendingPopup` state here any more.
 *
 * The popup controller owns its own lifecycle (including its timeout and its
 * dismissal rules), so there is exactly one source of truth about whether a popup
 * is on screen. The old design kept a parallel flag that was only cleared by the
 * native menu's dismissal callback — which does not fire reliably on Windows, so
 * one click outside left the flag set forever and every later hotkey press was
 * answered with `busy`.
 */

/**
 * Answer a popup that is still waiting, so a shutdown never leaves the caller's
 * `popup.show` hanging until its own timeout.
 *
 * @param {string|null} choice
 */
function resolvePendingPopup(choice) {
  try {
    if (choice === null || choice === undefined) popup?.close();
    else popup?.answer(choice);
  } catch {
    /* ignore */
  }
}

/** Hotkey currently held in `globalShortcut`, so we can unregister precisely. */
let registeredHotkey = null;

// ------------------------------------------------------------------ hotkey ==

/**
 * (Re)register the global toggle hotkey.
 *
 * Exactly the configured accelerator is registered — never a substitute. An
 * automatic swap silently changes a key the user chose, and they would have no way
 * to know why the key they pressed does nothing; the conflict is reported instead,
 * in the place where it can be fixed (「设置 → 便签设置」).
 *
 * `globalShortcut.register` returns false when another application already owns the
 * accelerator — a normal, reportable condition, not a crash. `Ctrl+Alt+S` in
 * particular is claimed by screen-capture tools on many Windows machines
 * (measured as unavailable on this one).
 *
 * @param {string} accelerator
 * @returns {{
 *   ok: boolean, hotkey: string, requested: string, replaced: boolean,
 *   registered: boolean, error?: string, warning?: string,
 * }}
 */
function applyHotkey(accelerator) {
  const wanted = typeof accelerator === 'string' && accelerator.trim().length > 0 ? accelerator.trim() : null;

  if (registeredHotkey !== null) {
    try {
      globalShortcut.unregister(registeredHotkey);
    } catch {
      /* ignore */
    }
    registeredHotkey = null;
  }
  if (wanted === null) {
    return { ok: true, hotkey: '', requested: '', replaced: false, registered: false };
  }

  let ok = false;
  try {
    ok = globalShortcut.register(wanted, () => {
      void showPopupAtCursor().catch((error) => emit('helper.error', { message: String(error) }));
    });
  } catch (error) {
    return {
      ok: false,
      hotkey: '',
      requested: wanted,
      replaced: false,
      registered: false,
      error: `快捷键 ${wanted} 注册失败：${error instanceof Error ? error.message : String(error)}`,
      warning: 'conflict',
    };
  }

  if (!ok) {
    // Defensively drop a half-registered accelerator so we never hold a key we
    // reported as unavailable.
    try {
      if (globalShortcut.isRegistered(wanted)) globalShortcut.unregister(wanted);
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      hotkey: '',
      requested: wanted,
      replaced: false,
      registered: false,
      error: `快捷键 ${wanted} 已被其他程序占用，请换一个组合`,
      warning: 'conflict',
    };
  }

  registeredHotkey = wanted;
  return { ok: true, hotkey: wanted, requested: wanted, replaced: false, registered: true };
}

// ------------------------------------------------------------------- popup ==

/**
 * Show the "new note / screenshot" popup at the current pointer position, then
 * carry out whatever the user picked.
 *
 * `forcedChoice` skips the popup. The popup surface is interactive, so the two
 * action branches below cannot be driven without either a human or this override;
 * passing the choice lets the same code path be exercised end to end.
 *
 * @param {{ forcedChoice?: string }} [options]
 */
async function showPopupAtCursor(options = {}) {
  if (popup === null) throw new Error('弹窗控制器未就绪');

  const forced =
    options.forcedChoice === 'new-note' || options.forcedChoice === 'shot' ? options.forcedChoice : null;
  const point = cursorPoint();

  let choice = forced;
  if (choice === null) {
    if (popup.isOpen) return { choice: null, busy: true };
    // The controller now owns its own timeout and its own dismissal rules; the
    // promise settles exactly once, whether the user picks a row, presses Escape,
    // moves the pointer away, or the safety timeout expires.
    choice = await new Promise((resolve) => {
      popup.show(point, resolve);
    });
  }

  if (choice === 'new-note') {
    const note = notes.createTextNote(point);
    return { choice, note };
  }
  if (choice === 'shot') {
    const result = await capture.runCapture({ mode: 'note', settings });
    return { choice, ...result };
  }
  return { choice };
}

// -------------------------------------------------------------- ipc bridge ==

/** Register the renderer-facing IPC surface for note, popup and shot windows. */
function installIpc() {
  // ---------------------------------------------------------------- note ----
  ipcMain.handle('note:init', (event) => {
    const id = notes.idForWebContents(event.sender.id);
    if (id === null) return { note: null, settings, unsaved: false };
    return { note: notes.getNote(id), settings, unsaved: notes.isUnsaved(id) };
  });

  ipcMain.handle('note:save', (event, payload) => {
    const id = notes.idForWebContents(event.sender.id);
    if (id === null) return { ok: false };
    const result = notes.patchFromRenderer(id, {
      text: typeof payload?.text === 'string' ? payload.text : '',
      title: typeof payload?.title === 'string' ? payload.title : undefined,
    });
    // 「保存」 is what files a draft, and ONLY 「保存」.
    //
    // This channel also carries the debounced auto-save, so the distinction cannot be
    // inferred from the call itself — the renderer marks a real save with
    // `explicit: true`. Filing on any save would mean merely typing a draft note put it
    // into the note list, which is exactly what the draft rule exists to prevent.
    if (result.ok === true && payload?.explicit === true) notes.commitDraft(id);
    return result;
  });

  ipcMain.handle('note:update', (event, patch) => {
    const id = notes.idForWebContents(event.sender.id);
    if (id === null) return { ok: false };
    return notes.patchFromRenderer(id, patch ?? {});
  });

  ipcMain.handle('note:commitText', (event, payload) => {
    const id = notes.idForWebContents(event.sender.id);
    if (id === null) return { ok: false };
    return notes.patchFromRenderer(id, { text: typeof payload?.text === 'string' ? payload.text : '' });
  });

  ipcMain.handle('note:setBounds', (event, bounds) => {
    const id = notes.idForWebContents(event.sender.id);
    if (id === null) return { ok: false };
    return notes.setBoundsFromRenderer(id, bounds ?? {});
  });

  ipcMain.handle('note:setSize', (event, size) => {
    const id = notes.idForWebContents(event.sender.id);
    if (id === null) return { ok: false };
    return notes.setSizeFromRenderer(id, size ?? {});
  });

  ipcMain.handle('note:dragState', (event, payload) => {
    const id = notes.idForWebContents(event.sender.id);
    if (id === null) return { ok: false };
    return notes.setInteractionState(id, payload ?? {});
  });

  ipcMain.handle('note:close', (event) => {
    const id = notes.idForWebContents(event.sender.id);
    if (id !== null) notes.closeWindow(id);
    return { ok: true };
  });

  ipcMain.handle('note:delete', (event) => {
    const id = notes.idForWebContents(event.sender.id);
    if (id !== null) notes.remove(id);
    return { ok: true };
  });

  ipcMain.handle('note:hide', (event, payload) => {
    const id = notes.idForWebContents(event.sender.id);
    if (id === null) return { ok: false };
    return notes.setHidden(id, payload?.hidden === true);
  });

  ipcMain.handle('note:setPinned', (event, payload) => {
    const id = notes.idForWebContents(event.sender.id);
    if (id === null) return { ok: false };
    return notes.setPinned(id, payload?.pinned === true);
  });

  ipcMain.handle('note:exportImage', async (event) => {
    const id = notes.idForWebContents(event.sender.id);
    if (id === null) return { path: null };
    const note = notes.getNote(id);
    if (note === null || typeof note.image !== 'string') return { path: null };
    try {
      const dir = settings.exportDir && settings.exportDir.length > 0 ? settings.exportDir : dataDir;
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = join(dir, `sticky-shot-${stamp}.png`);
      writeFileSync(target, readFileSync(note.image));
      return { path: target };
    } catch (error) {
      return { path: null, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // --------------------------------------------------------------- popup ----
  //
  // Only the popup window itself may answer, and only while it is the live one:
  // a click that races the pointer-away dismissal must not dispatch a second action.
  const fromPopup = (event) => popup !== null && popup.window !== null && popup.window.webContents.id === event.sender.id;

  ipcMain.handle('popup:items', (event) => {
    if (!fromPopup(event)) return { items: [] };
    return { items: POPUP_ITEMS.map((item) => ({ ...item })) };
  });

  ipcMain.handle('popup:choose', (event, payload) => {
    if (!fromPopup(event)) return { ok: false, error: '弹窗已关闭' };
    popup.answer(payload?.id === 'shot' ? 'shot' : payload?.id === 'new-note' ? 'new-note' : null);
    return { ok: true };
  });

  ipcMain.handle('popup:dismiss', (event) => {
    if (!fromPopup(event)) return { ok: false, error: '弹窗已关闭' };
    popup.answer(null);
    return { ok: true };
  });

  // ---------------------------------------------------------------- shot ----
  ipcMain.handle('shot:init', (event) => capture.initPayload(event.sender.id));

  ipcMain.handle('shot:commit', async (event, payload) => {
    try {
      return await capture.commit(event.sender.id, payload ?? {});
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('shot:cancel', (event) => {
    capture.cancel(event.sender.id);
    return { ok: true };
  });

  ipcMain.handle('shot:copy', async (_event, payload) => {
    try {
      const image = nativeImage.createFromDataURL(String(payload?.dataUrl ?? ''));
      if (image.isEmpty()) return { ok: false, error: '图像为空' };
      await writeImageToClipboard(image);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // --------------------------------------------------------------- alarm ----
  //
  // Only the alarm window may read or dismiss itself, and only while it is the live window
  // for that alarm: a dismissal racing a re-fire must not close the new popup.
  ipcMain.handle('alarm:init', (event) => {
    return alarms === null ? { error: '闹钟未就绪' } : alarms.payloadFor(event.sender.id);
  });

  ipcMain.handle('alarm:close', (event) => {
    if (alarms === null) return { ok: false };
    const payload = alarms.payloadFor(event.sender.id);
    const id = payload?.alarm?.id;
    if (typeof id !== 'string') return { ok: false, error: '闹钟窗口不存在' };
    alarms.close(id);
    return { ok: true, id };
  });
}

/**
 * Put an image on the system clipboard.
 *
 * Electron 40 replaced the old clipboard surface with the W3C one: `clipboard.writeImage`
 * and `writeText` (sync) are gone, and `clipboard.write([ClipboardItem])` / `writeText()`
 * are the supported calls (async). The old call still type-checks but is `undefined` at
 * runtime, so the user saw "复制失败：clipboard.writeImage is not a function".
 *
 * Both paths are attempted so this keeps working across the version we ship and any
 * older runtime a user may have pointed `DSH_STICKY_NOTES_ELECTRON` at.
 *
 * @param {import('electron').NativeImage} image
 */
async function writeImageToClipboard(image) {
  const png = image.toPNG();
  if (typeof ClipboardItem === 'function' && typeof clipboard.write === 'function') {
    const blob = new Blob([png], { type: 'image/png' });
    await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return;
  }
  // Legacy surface, only reached on a runtime predating the W3C rewrite.
  const legacy = clipboard.writeImage ?? clipboard.write;
  if (typeof legacy !== 'function') throw new Error('当前 Electron 运行时不支持写图片到剪贴板');
  legacy.call(clipboard, image);
}

// ------------------------------------------------------------ method table ==

/**
 * The NDJSON method table. Each entry returns a JSON-serialisable result.
 * @param {string} method
 * @param {object} params
 */
async function dispatch(method, params) {
  switch (method) {
    case 'helper.ping':
      return { ok: true, version: process.versions.electron ?? 'unknown' };

    case 'shot.inspect': {
      // Diagnostic: read the live `window.shot` and the page's own fallback state.
      return capture.inspect();
    }

    case 'shot.eval': {
      // Diagnostic: drive the annotation page the way a user's clicks do.
      return capture.evaluate(String(params?.script ?? ''));
    }

    case 'alarm.show': {
      if (alarms === null) return { ok: false, error: '闹钟未就绪' };
      const alarm = params?.alarm ?? {};
      // A preview of an *unsaved* alarm: creating a new one has no id yet, and that is
      // precisely the moment the user wants to 试响 and position it. A stable placeholder id
      // lets that work without inventing a record.
      if (params?.draft === true || typeof alarm.id !== 'string' || alarm.id.length === 0) {
        return alarms.show({ ...alarm, id: DRAFT_ALARM_ID });
      }
      return alarms.show(alarm);
    }

    case 'alarm.close': {
      return { ok: alarms === null ? false : alarms.close(String(params?.id ?? '')) };
    }

    case 'alarm.setPosition': {
      // Test hook: move an alarm popup the way a user drag would, so the `alarm.moved` event
      // path can be exercised without synthetic input. The rejection is deliberate — moving
      // the window really does fire `move`, which is what the host listens for.
      if (alarms === null) return { ok: false, error: '闹钟未就绪' };
      const entry = alarms.windowFor(String(params?.id ?? ''));
      if (entry === null) return { ok: false, error: '闹钟窗口不存在' };
      try {
        entry.setBounds({ x: Math.round(Number(params?.x) || 0), y: Math.round(Number(params?.y) || 0) });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    case 'alarm.list': {
      return { ids: alarms === null ? [] : alarms.openIds() };
    }

    case 'alarm.bounds': {
      // Where one specific alarm's popup is. Needed because every popup shares the page's
      // title — `setTitle` is overridden by the page `<title>` — so a caller cannot pick one
      // out of `helper.windows` by name.
      return { bounds: alarms === null ? null : alarms.boundsFor(String(params?.id ?? '')) };
    }

    case 'alarm.pickImage': {
      // 「选择图片」 for an image alarm. The picker has to run in a process that owns a
      // window and can show a native dialog; the browser half only has an HTTP endpoint.
      if (alarms === null) return { ok: false, error: '闹钟未就绪' };
      try {
        const result = await dialog.showOpenDialog({
          title: '选择闹钟要显示的图片',
          properties: ['openFile'],
          filters: [
            { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
            { name: '所有文件', extensions: ['*'] },
          ],
        });
        if (result.canceled === true || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
          return { ok: true, path: null };
        }
        return { ok: true, path: result.filePaths[0] };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    case 'helper.windows': {
      // Every top-level window and whether it is actually on screen. Nothing else reports
      // this: a window that is created but never shown is invisible to every other call,
      // which is exactly how "the screenshot does nothing" hides.
      return {
        windows: BrowserWindow.getAllWindows().map((window) => {
          let bounds = null;
          try {
            bounds = window.getBounds();
          } catch {
            /* ignore */
          }
          return {
            id: window.id,
            visible: window.isVisible(),
            destroyed: window.isDestroyed(),
            loading: window.webContents.isLoading(),
            crashed: window.webContents.isCrashed(),
            title: window.getTitle(),
            bounds,
          };
        }),
      };
    }

    case 'helper.config': {
      if (typeof params?.dataDir === 'string' && params.dataDir.length > 0) dataDir = params.dataDir;
      if (params?.settings !== undefined && params.settings !== null) {
        settings = { ...settings, ...params.settings };
      }
      // Now that the data directory is known, claim it. A second helper on the
      // same directory is told so plainly instead of silently duplicating
      // windows and fighting over the global hotkey.
      const lock = acquireNotesLock();
      if (lock.ok !== true) {
        return { ok: false, dataDir, settings, hotkey: null, error: lock.reason };
      }
      // `hotkey` is the registration *outcome* (`{ ok, hotkey, error }`) rather
      // than the accelerator alone, because the settings page needs to explain a
      // refused combination. `settings.apply` returns the identical shape.
      const hotkey = applyHotkey(settings.hotkey);
      return { ok: true, dataDir, settings, hotkey };
    }

    case 'displays.list':
      return {
        displays: screen.getAllDisplays().map((display) => ({
          id: display.id,
          bounds: display.bounds,
          workArea: display.workArea,
          scaleFactor: display.scaleFactor,
        })),
      };

    case 'settings.apply': {
      if (params?.settings !== undefined && params.settings !== null) {
        settings = { ...settings, ...params.settings };
      }
      const hotkey = applyHotkey(settings.hotkey);
      notes?.applySettings(settings);
      return { ok: true, settings, hotkey };
    }

    case 'note.create': {
      if (params?.settings !== undefined && params.settings !== null) {
        settings = { ...settings, ...params.settings };
      }
      const note = params?.note ?? {};
      // `activate` follows the caller's intent. Any user-facing path (the hotkey, or
      // the panel's 「新建便签」) passes `true` so the note comes up able to receive
      // keystrokes; a restore passes `false` so a restart does not pull focus out of
      // whatever the user was doing.
      return { id: notes.create(note, { activate: params?.activate === true }) };
    }

    case 'note.commitDraft': {
      // File a hotkey-created draft: the helper announces it so the host store can
      // record it. This is what makes the note appear in the sidebar list, and it is
      // reached only from an explicit 「保存」.
      return notes.commitDraft(String(params?.id ?? ''));
    }

    case 'note.update': {
      const id = String(params?.id ?? '');
      notes.applyPatch(id, params?.patch ?? {});
      return { ok: true };
    }

    case 'note.remove': {
      notes.remove(String(params?.id ?? ''));
      return { ok: true };
    }

    case 'note.close': {
      notes.closeWindow(String(params?.id ?? ''));
      return { ok: true };
    }

    case 'note.focus': {
      notes.focus(String(params?.id ?? ''));
      return { ok: true };
    }

    case 'note.state': {
      // Diagnostics for the test suite: the auto-hide decision depends on focus and
      // edge state that no other call reports, so a failing auto-hide is otherwise
      // indistinguishable from a slow one.
      const id = String(params?.id ?? '');
      const note = notes.getNote(id);
      const win = notes.windowFor(id);
      return {
        note,
        unsaved: notes.isUnsaved(id),
        focused: win === null ? null : win.isFocused(),
        webFocused: win === null ? null : win.webContents.isFocused(),
        visible: win === null ? null : win.isVisible(),
        bounds: win === null ? null : win.getBounds(),
        // The inputs the auto-hide decision is made from, so a note that refuses to hide
        // can be told apart from one that is merely slow.
        gesture: notes.gestureOf(id),
        typing: notes.isTyping(id),
        gestureExplanation: notes.explainGesture(id),
      };
    }

    case 'note.blur': {
      // "The user is done with this note." Auto-hide is suppressed while a note holds
      // focus, so a caller that wants the note to go back to its edge behaviour — a
      // panel action, or a test standing in for a user who looked away — says so here.
      return notes.blur(String(params?.id ?? ''));
    }

    case 'note.setHidden': {
      notes.setHidden(String(params?.id ?? ''), params?.hidden === true, params?.edge);
      return { ok: true };
    }

    case 'note.setPinned': {
      return notes.setPinned(String(params?.id ?? ''), params?.pinned === true);
    }

    case 'note.setBounds': {
      // Same entry point the note window uses while dragging. Exposed on this surface so
      // a test can reproduce a drag frame by frame; a single jump in position does not
      // exercise the same code path.
      return notes.setBoundsFromRenderer(String(params?.id ?? ''), {
        x: Number(params?.x),
        y: Number(params?.y),
      });
    }

    case 'note.list':
      return { ids: notes.listIds() };

    case 'note.get': {
      // Live per-note state, including the real window bounds. Used by the test
      // suite and by diagnostics, because "did the note actually collapse to its
      // edge tab?" cannot be answered from the ids alone.
      const note = notes.getNote(String(params?.id ?? ''));
      if (note === null) return { note: null };
      return { note, bounds: notes.boundsOf(note.id) };
    }

    case 'note.reconcile': {
      // The host sends the full desired set on startup so note windows match the
      // store — including the hidden/snapped state from the previous session.
      const wanted = Array.isArray(params?.notes) ? params.notes : [];
      if (params?.settings !== undefined && params.settings !== null) {
        settings = { ...settings, ...params.settings };
        notes.applySettings(settings);
      }
      notes.reconcile(wanted, settings);
      return { ids: notes.listIds() };
    }

    case 'popup.show':
      return showPopupAtCursor({ forcedChoice: params?.forcedChoice });

    case 'popup.state':
      // Inspection for the test suite: "is a popup on screen, and where?" cannot be
      // answered from the helper's own logs.
      return popup === null || !popup.isOpen || popup.window === null || popup.window.isDestroyed()
        ? { open: false, bounds: null }
        : { open: true, bounds: popup.window.getBounds() };

    case 'popup.items':
      // The rows the popup offers, so a caller (or the test suite) never has to
      // hard-code the ids.
      return { items: POPUP_ITEMS.map((item) => ({ ...item })) };

    case 'popup.click':
      // Drive the popup's own answer path without synthetic input, so the click
      // handler and the dismissal rules can both be exercised.
      popup?.answer(params?.id);
      return { ok: true };

    case 'popup.dismiss':
      popup?.answer(null);
      return { ok: true };

    case 'cursor.move':
      // Test-only pointer override; see `fixedCursor`.
      fixedCursor = { x: Number(params?.x) || 0, y: Number(params?.y) || 0 };
      return { ok: true, cursor: { ...fixedCursor } };

    case 'cursor.clear':
      fixedCursor = null;
      return { ok: true };

    case 'shot.begin':
      return capture.runCapture({
        mode: params?.mode === 'note' ? 'note' : 'file',
        settings,
      });

    case 'helper.quit':
      // Dismiss a popup still waiting for a human first: otherwise the caller's
      // `popup.show` stays pending and is rejected with a confusing transport error
      // when the process exits, instead of answering "the user chose nothing".
      resolvePendingPopup(null);
      setTimeout(() => app.quit(), 50);
      return { ok: true };

    default:
      throw new Error(`未知方法：${method}`);
  }
}

// ------------------------------------------------------------------- boot ==

/**
 * Announce the RPC endpoint on stdout.
 *
 * stdout is the one stream Electron's main process does give us, so it carries
 * the handshake and nothing else. The host reads exactly this one line before
 * connecting; anything the helper wants to say later goes over the socket.
 */
function announce(port) {
  try {
    process.stdout.write(`${JSON.stringify({ ready: true, port, token: TOKEN, pid: process.pid })}\n`);
  } catch {
    /* the host will time out and report a clean failure */
  }
}

/**
 * Take a per-data-directory lock so two helpers never fight over one set of
 * notes.
 *
 * Deliberately **not** `app.requestSingleInstanceLock()`: that lock is keyed on
 * the Electron binary itself, so a helper started by one DSH profile — or by this
 * plugin's own test suite, which runs the very same `electron.exe` — would
 * silently block the helper of an unrelated running DSH with "already-running".
 * The lock has to be scoped to the notes it protects, and the helper only learns
 * its data directory from `helper.config`, so the lock is taken lazily on that
 * first call rather than at startup.
 *
 * @returns {{ ok: boolean, reason?: string }}
 */
function acquireNotesLock() {
  if (notesLockState !== null) return notesLockState;
  try {
    mkdirSync(dataDir, { recursive: true });
    const lockFile = join(dataDir, 'helper.lock');
    if (existsSync(lockFile)) {
      const held = Number.parseInt(readFileSync(lockFile, 'utf8').trim(), 10);
      if (Number.isInteger(held) && held > 0 && held !== process.pid) {
        // A live holder wins; a stale file from a crashed helper is reclaimed.
        let alive = false;
        try {
          process.kill(held, 0);
          alive = true;
        } catch {
          alive = false;
        }
        if (alive) {
          notesLockState = { ok: false, reason: `另一个便签助手（pid ${held}）正在使用同一数据目录` };
          return notesLockState;
        }
      }
    }
    writeFileSync(lockFile, String(process.pid), 'utf8');
    notesLockState = { ok: true };
  } catch (error) {
    // A lock we cannot manage must not disable the feature: degrade to running
    // unlocked and say so, rather than refusing to show the user their notes.
    emit('helper.error', { message: `无法建立便签助手锁：${error instanceof Error ? error.message : String(error)}` });
    notesLockState = { ok: true, reason: 'lock-unavailable' };
  }
  return notesLockState;
}

/** Cached result of {@link acquireNotesLock}. */
let notesLockState = null;

// A transparent frameless window needs a compositor that can do it; disabling
// the GPU cache avoids the well-known white-box artifact on some drivers.
app.commandLine.appendSwitch('disable-gpu-compositing-cache');

app.on('window-all-closed', () => {
  // Deliberately NOT quitting: the helper outlives individual note windows so the
  // hotkey keeps working with every note closed.
});

app.on('will-quit', () => {
  // Answer an unanswered popup before the process goes away.
  resolvePendingPopup(null);
  try {
    // Alarm windows are transient by design — they are not restored, so closing them here
    // is what stops a stale alarm from lingering after the helper restarts.
    alarms?.closeAll();
  } catch {
    /* ignore */
  }
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* ignore */
  }
  // Release the notes lock so the next helper starts cleanly instead of having to
  // reclaim a stale file.
  try {
    const lockFile = join(dataDir, 'helper.lock');
    if (existsSync(lockFile) && readFileSync(lockFile, 'utf8').trim() === String(process.pid)) {
      rmSync(lockFile, { force: true });
    }
  } catch {
    /* ignore */
  }
  for (const socket of peers) {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  }
  peers.clear();
});

// A crash in the renderer must not take the helper down.
process.on('uncaughtException', (error) => {
  emit('helper.error', { message: `未捕获异常：${error instanceof Error ? error.message : String(error)}` });
});
process.on('unhandledRejection', (reason) => {
  emit('helper.error', { message: `未处理的拒绝：${String(reason)}` });
});

/** How often the helper checks whether DSH is still alive (ms). */
const PARENT_WATCH_MS = 4000;

/**
 * Exit when the DSH process that spawned us goes away.
 *
 * The host asks us to quit and now also force-kills our tree, but neither helps when
 * the host is killed outright — it then has no chance to run anything. An orphaned
 * helper is not merely untidy: it keeps `helper.lock` for its data directory, so the
 * next helper refuses to start and the user is told "another helper (pid N) is using
 * this directory" with no way to clear it short of a manual kill.
 *
 * `process.kill(pid, 0)` only probes for existence, so this is cheap enough to run on
 * a slow timer. A missing or unparsable pid means "no watchdog", which is the case
 * when the helper is started by hand for diagnostics.
 */
function installParentWatchdog() {
  const raw = process.env.DSH_STICKY_NOTES_PARENT_PID;
  const parentPid = Number.parseInt(typeof raw === 'string' ? raw : '', 10);
  if (!Number.isInteger(parentPid) || parentPid <= 0 || parentPid === process.pid) return;

  const timer = setInterval(() => {
    let alive = false;
    try {
      process.kill(parentPid, 0);
      alive = true;
    } catch (error) {
      // EPERM means it exists but belongs to another user: still alive.
      alive = error !== null && typeof error === 'object' && error.code === 'EPERM';
    }
    if (alive) return;
    clearInterval(timer);
    if (typeof timer.unref === 'function') timer.unref();
    emit('helper.log', { message: `DSH（pid ${parentPid}）已退出，助手自动关闭` });
    // `app.quit()` runs `will-quit`, which releases the lock and closes peers.
    try {
      app.quit();
    } catch {
      process.exit(0);
    }
  }, PARENT_WATCH_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

// Installed before `whenReady` so the watchdog is running even if startup fails part
// way through — a half-started helper is exactly the kind that lingers.
installParentWatchdog();

app.whenReady().then(async () => {
  try {
    // Windows needs an explicit AppUserModelID for correct always-on-top
    // z-ordering; harmless elsewhere.
    if (process.platform === 'win32') app.setAppUserModelId('com.deepseek.dsh.sticky-notes');
  } catch {
    /* ignore */
  }

  try {
    notes = new NoteManager({ settings, emit, dataDir });
    popup = new PopupController({
      emit,
      logger: (message) => emit('helper.log', { message }),
      // Read live, so the test pointer override takes effect immediately.
      getCursor: () => cursorPoint(),
    });
    capture = new CaptureController({
      emit,
      settings: () => settings,
      dataDir: () => dataDir,
      // 「存为便签」 builds a real note through the same manager every other note uses, so
      // the screenshot note gets always-on-top, dragging, edge behaviour and appearance
      // for free rather than being a special case.
      notes: () => notes,
      // Screenshots must not contain our own floating windows.
      hideNotes: () => notes?.hideAllForCapture(),
    });
    alarms = new AlarmWindows({
      emit,
      logger: (message) => emit('helper.log', { message }),
    });
    installIpc();
  } catch (error) {
    emit('helper.error', { message: `助手初始化失败：${error instanceof Error ? error.message : String(error)}` });
  }

  // The RPC endpoint must come up even when a subsystem above failed: the host
  // needs *somewhere* to send `helper.ping` so it can report what is broken.
  try {
    const port = await startRpcServer({ onRequest: handleLine });
    announce(port);
    emit('helper.ready', readyPayload());
  } catch (error) {
    try {
      process.stdout.write(
        `${JSON.stringify({ ready: false, reason: error instanceof Error ? error.message : String(error) })}\n`,
      );
    } catch {
      /* ignore */
    }
    emit('helper.error', { message: `RPC 服务器启动失败：${error instanceof Error ? error.message : String(error)}` });
  }
});
