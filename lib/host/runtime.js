/**
 * dsh-sticky-notes — Electron helper runtime discovery and supervision.
 *
 * The DSH **host** process runs under `ELECTRON_RUN_AS_NODE=1`, so it is plain
 * Node: there is no `BrowserWindow`, no `screen`, no `globalShortcut`. Real
 * always-on-top windows therefore require a *separate* Electron runtime that we
 * spawn as a child process and drive over stdio NDJSON.
 *
 * Runtime resolution order (first verified hit wins):
 *
 *   1. `DSH_STICKY_NOTES_ELECTRON` — explicit override, for tests and for users
 *      who already keep an Electron build somewhere.
 *   2. `~/.dsh/dsh-orb/electron-runtime` — the runtime the `dsh-orb` plugin
 *      already downloads. Reusing it costs nothing and avoids a second ~120 MB
 *      download on machines that have both plugins.
 *   3. `~/.dsh/sticky-notes/electron-runtime` — our own copy, downloaded on
 *      first use when neither of the above exists.
 *
 * Nothing here throws at module scope, and nothing downloads unless
 * {@link ElectronRuntime.ensure} is actually called: importing this module must
 * stay free of side effects so a broken/missing runtime can never take the DSH
 * host down with it.
 *
 * @module dsh-sticky-notes/host/runtime
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** `require` for this ESM module, used for the lazily-imported child_process. */
const require = createRequire(import.meta.url);

/** Electron release we mirror. Matches the DSH desktop shell's own major. */
export const ELECTRON_VERSION = '44.0.0';

/** Mirrors that serve Electron binaries, in order of preference. */
const RELEASE_BASE = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}`;
const MIRROR_BASE = `https://cdn.npmmirror.com/binaries/electron/v${ELECTRON_VERSION}`;

/** Where `@deepseek-ai/dsh-home-paths` keeps its state; resolved lazily. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (typeof home !== 'string' || home.length === 0) return null;
  return join(home, '.dsh');
}

/**
 * Candidate directories, most-preferred first.
 * @returns {string[]}
 */
export function runtimeCandidates() {
  const out = [];
  const override = process.env.DSH_STICKY_NOTES_ELECTRON;
  if (typeof override === 'string' && override.length > 0) out.push(override);
  const home = dshHome();
  if (home !== null) {
    out.push(join(home, 'dsh-orb', 'electron-runtime'));
    out.push(join(home, 'sticky-notes', 'electron-runtime'));
  }
  return out;
}

/** Executable name for this platform. */
function executableName() {
  if (process.platform === 'win32') return 'electron.exe';
  if (process.platform === 'darwin') {
    // Electron's macOS zip nests the binary inside the .app bundle.
    return join('Electron.app', 'Contents', 'MacOS', 'Electron');
  }
  return 'electron';
}

/**
 * A candidate counts as usable when its executable exists. We deliberately do
 * NOT require the `.complete-<version>` marker: `dsh-orb` writes one, but a
 * hand-placed build or an override path may not have it, and a missing marker
 * says nothing about whether the binary runs.
 *
 * @param {string} dir
 * @returns {string|null} the absolute executable path, or null
 */
export function executableIn(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return null;
  const exe = join(dir, executableName());
  try {
    return existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

/**
 * Locate an Electron executable without downloading anything.
 * @returns {{ path: string, source: string }|null}
 */
export function findElectron() {
  for (const dir of runtimeCandidates()) {
    const exe = executableIn(dir);
    if (exe !== null) return { path: exe, source: dir };
  }
  return null;
}

/** Where our own runtime download lands. */
function ownedRuntimeDir() {
  const home = dshHome();
  if (home === null) throw new Error('无法确定 DSH_HOME，无法定位 Electron 运行时目录');
  return join(home, 'sticky-notes', 'electron-runtime');
}

/** Archive name for the current platform/arch. */
function archiveName() {
  const platform = process.platform;
  const arch = process.arch;
  const supported = [
    ['win32', 'x64'],
    ['win32', 'arm64'],
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
  ];
  if (!supported.some(([p, a]) => p === platform && a === arch)) {
    throw new Error(`不支持的平台：${platform}/${arch}`);
  }
  return `electron-v${ELECTRON_VERSION}-${platform}-${arch}.zip`;
}

/**
 * Download and unpack our own Electron runtime.
 *
 * Uses `tar` (bsdtar, present on Windows 10+ and macOS/Linux) to extract the
 * zip. `tar` is preferred over a JS unzip dependency so this plugin keeps a
 * zero-runtime-dependency footprint.
 *
 * @param {(message: string) => void} [log]
 * @returns {Promise<string>} absolute path to the executable
 */
export async function downloadElectron(log = () => {}) {
  const dest = ownedRuntimeDir();
  const exe = executableIn(dest);
  if (exe !== null) return exe;

  const parent = dirname(dest);
  await mkdir(parent, { recursive: true });

  const archive = archiveName();
  const zipPath = join(parent, `.electron-${process.pid}.zip`);
  const staging = join(parent, `.electron-staging-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  const urls = [`${MIRROR_BASE}/${archive}`, `${RELEASE_BASE}/${archive}`];
  let lastError = null;
  let downloaded = false;

  for (const url of urls) {
    try {
      log(`sticky-notes: 正在下载 Electron 运行时 ${url}`);
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok || response.body === null) {
        throw new Error(`HTTP ${response.status}`);
      }
      await pipeline(response.body, createWriteStream(zipPath));
      downloaded = true;
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      log(`sticky-notes: 下载失败（${url}）：${String(error)}`);
      await rm(zipPath, { force: true });
    }
  }

  if (!downloaded) {
    await rm(staging, { recursive: true, force: true });
    throw new Error(`Electron 运行时下载失败：${lastError === null ? '未知错误' : String(lastError)}`);
  }

  try {
    log('sticky-notes: 正在解压 Electron 运行时…');
    // `tar -xf` handles zip on bsdtar (Windows 10+, macOS). GNU tar on Linux
    // cannot read zip, so fall back to `unzip` there.
    try {
      await execFileAsync('tar', ['-xf', zipPath, '-C', staging], { windowsHide: true });
    } catch (tarError) {
      await execFileAsync('unzip', ['-q', '-o', zipPath, '-d', staging], { windowsHide: true });
    }

    const staged = executableIn(staging);
    if (staged === null) throw new Error('解压后未找到 Electron 可执行文件');

    if (process.platform !== 'win32') {
      await chmod(staged, 0o755).catch(() => {});
    }

    await rm(dest, { recursive: true, force: true });
    await rename(staging, dest);

    const finalExe = executableIn(dest);
    if (finalExe === null) throw new Error('安装后未找到 Electron 可执行文件');
    await writeFile(join(dest, `.complete-${ELECTRON_VERSION}`), ELECTRON_VERSION, 'utf8').catch(() => {});
    return finalExe;
  } finally {
    await rm(zipPath, { force: true }).catch(() => {});
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Resolve an Electron executable, downloading one only when necessary.
 *
 * @param {{ log?: (message: string) => void, allowDownload?: boolean }} [options]
 * @returns {Promise<{ path: string, source: string }>}
 */
export async function ensureElectron(options = {}) {
  const { log = () => {}, allowDownload = true } = options;
  const found = findElectron();
  if (found !== null) {
    log(`sticky-notes: 复用 Electron 运行时 ${found.path}`);
    return found;
  }
  if (!allowDownload) {
    throw new Error('未找到 Electron 运行时，且已禁止自动下载');
  }
  const path = await downloadElectron(log);
  return { path, source: dirname(path) };
}

/** How many early events to keep for a late subscriber before dropping oldest. */
const EVENT_BUFFER_LIMIT = 64;

/**
 * Client for the Electron helper.
 *
 * Transport is newline-delimited JSON over a loopback TCP socket, **not** stdio:
 * Electron's main process gives `process.stdin` no usable fd (the stream reports
 * `readable: true`, then `'end'` fires immediately and no byte ever arrives), so
 * stdin cannot carry requests. The helper therefore opens a `127.0.0.1` server on
 * an OS-assigned port and announces `{ ready, port, token }` on stdout, which is
 * the one stream that does work. The token gates the socket, so a different
 * local process cannot drive the user's note windows.
 *
 * Crash-safety contract: a helper that dies, hangs, or writes garbage must
 * surface as a rejected promise on the affected call — never as an unhandled
 * exception or an unhandled `'error'` event.
 */
export class ElectronHelperClient {
  #child = null;
  #socket = null;
  #buffer = '';
  #stdoutBuffer = '';
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();
  /** Events that arrived before the first subscriber; replayed on subscribe. */
  #bufferedEvents = [];
  #replaying = false;
  #disposed = false;
  #ready = false;
  #log;

  /**
   * @param {object} options
   * @param {string} options.exe           path to the Electron executable
   * @param {string} options.script        path to the Electron main script
   * @param {string} [options.cwd]         working directory (the app dir)
   * @param {(message: string) => void} [options.log]
   * @param {number} [options.handshakeTimeoutMs]
   */
  constructor(options) {
    this.#log = options.log ?? (() => {});
    this.#handshakeTimeoutMs = Number.isFinite(options.handshakeTimeoutMs) ? options.handshakeTimeoutMs : 30000;
    this.#spawn(options);
  }

  #handshakeTimeoutMs;
  #handshakeDone = null;

  /**
   * Wait for the helper to announce itself and for the RPC socket to open.
   *
   * Split out of the constructor on purpose: starting Electron takes seconds,
   * and a constructor must not be the thing that makes plugin load time depend
   * on a child process. The caller decides when to wait.
   *
   * @returns {Promise<this>}
   */
  ready() {
    if (this.#disposed) return Promise.reject(new Error('Electron 助手已释放'));
    if (this.#ready) return Promise.resolve(this);
    if (this.#handshake === null) return Promise.reject(new Error('Electron 助手未启动'));
    return this.#handshake.then(() => this);
  }

  #handshake = null;

  /** Spawn the helper and begin the handshake. */
  #spawn(options) {
    const child = spawn(options.exe, [options.script], {
      cwd: options.cwd,
      windowsHide: true,
      // stdin is useless to Electron's main process; hand it a pipe we never
      // write to rather than leaving it inherited.
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // The helper IS Electron; clear the flag DSH sets for its own host so
        // this child gets the full Electron API.
        ELECTRON_RUN_AS_NODE: undefined,
        DSH_STICKY_NOTES_HELPER: '1',
        // The helper watches this pid and exits on its own if it disappears. Child
        // processes are not reliably reaped when a parent dies abruptly (a crash, or
        // a task-manager kill), and a helper that outlives its host keeps
        // `helper.lock` — which then makes the *next* helper refuse to start, so the
        // user sees "another helper is using this directory" after a hard restart.
        DSH_STICKY_NOTES_PARENT_PID: String(process.pid),
      },
    });
    this.#child = child;

    this.#handshake = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Electron 助手握手超时（${this.#handshakeTimeoutMs}ms）`));
      }, this.#handshakeTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      this.#handshakeDone = {
        succeed: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        fail: (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      };

      // stdout carries exactly one handshake line and nothing else.
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => this.#onStdout(chunk));

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text.length > 0) this.#log(`sticky-notes/electron: ${text}`);
      });

      child.on('error', (error) => {
        const message = `Electron 助手启动失败：${String(error)}`;
        this.#failAll(new Error(message));
        this.#handshakeDone?.fail(new Error(message));
      });
      child.on('exit', (code, signal) => {
        this.#child = null;
        this.#ready = false;
        const message = `Electron 助手已退出（code=${String(code)} signal=${String(signal)}）`;
        this.#failAll(new Error(message));
        this.#handshakeDone?.fail(new Error(message));
      });
    });

    // Nothing awaits the handshake unless `ready()` is called; keep Node from
    // treating an unobserved rejection as a fatal error.
    this.#handshake.catch(() => {});
  }

  /** Parse the handshake line, then connect the socket. */
  #onStdout(chunk) {
    this.#stdoutBuffer += chunk;
    let index = this.#stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.#stdoutBuffer.slice(0, index).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(index + 1);
      index = this.#stdoutBuffer.indexOf('\n');
      if (line.length === 0) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#log(`sticky-notes: 忽略助手 stdout 的非 JSON 输出：${line.slice(0, 200)}`);
        continue;
      }

      if (message?.ready !== true) {
        const reason = message?.reason ?? '未知原因';
        this.#handshakeDone?.fail(new Error(`Electron 助手未能就绪：${reason}`));
        continue;
      }
      if (this.#socket !== null || this.#disposed) continue;

      void this.#connect(Number(message.port), String(message.token ?? '')).catch((error) => {
        this.#handshakeDone?.fail(error instanceof Error ? error : new Error(String(error)));
      });
    }
    if (this.#stdoutBuffer.length > 1024 * 1024) this.#stdoutBuffer = '';
  }

  /** Open the RPC socket and complete the handshake. */
  async #connect(port, token) {
    if (!Number.isInteger(port) || port <= 0) throw new Error('Electron 助手返回了非法端口');
    const { connect } = require('node:net');

    const socket = connect({ host: '127.0.0.1', port });
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    this.#socket = socket;

    await new Promise((resolve, reject) => {
      let opened = false;
      let handshakeSettled = false;

      socket.once('connect', () => {
        opened = true;
        // The handshake frame must be first on the wire.
        socket.write(`${JSON.stringify({ hello: true, token })}\n`);
      });

      socket.on('data', (chunk) => {
        this.#buffer += chunk;
        let index = this.#buffer.indexOf('\n');
        while (index >= 0) {
          const line = this.#buffer.slice(0, index);
          this.#buffer = this.#buffer.slice(index + 1);
          index = this.#buffer.indexOf('\n');
          if (line.trim().length === 0) continue;

          // The very first frame the helper sends is the authorisation reply,
          // which doubles as the readiness report.
          if (!handshakeSettled) {
            handshakeSettled = true;
            let reply = null;
            try {
              reply = JSON.parse(line);
            } catch {
              reply = null;
            }
            if (reply?.ok === true && reply.result?.authorised === true) {
              this.#readyInfo = reply.result.ready ?? null;
              this.#ready = true;
              this.#handshakeDone?.succeed();
              resolve();
            } else {
              const reason = reply?.error ?? '握手响应无效';
              this.#handshakeDone?.fail(new Error(String(reason)));
              reject(new Error(`Electron 助手拒绝了握手：${String(reason)}`));
            }
            continue;
          }

          this.#onLine(line);
        }
        if (this.#buffer.length > 8 * 1024 * 1024) this.#buffer = '';
      });

      const onError = (error) => {
        if (!opened) {
          reject(new Error(`连接 Electron 助手失败：${String(error)}`));
          return;
        }
        this.#failAll(new Error(`Electron 助手连接中断：${String(error)}`));
        if (!handshakeSettled) {
          handshakeSettled = true;
          reject(new Error(`Electron 助手连接中断：${String(error)}`));
        }
      };
      socket.on('error', onError);

      socket.on('close', () => {
        this.#socket = null;
        this.#ready = false;
        if (this.#disposed) return;
        this.#failAll(new Error('Electron 助手连接已关闭'));
        if (!handshakeSettled) {
          handshakeSettled = true;
          reject(new Error('Electron 助手在握手完成前关闭了连接'));
        }
      });
    });
  }

  #onSocketData(chunk) {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.trim().length > 0) this.#onLine(line);
      index = this.#buffer.indexOf('\n');
    }
    // Guard against a pathological helper that never emits a newline.
    if (this.#buffer.length > 8 * 1024 * 1024) this.#buffer = '';
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#log(`sticky-notes: 忽略无法解析的助手输出：${line.slice(0, 200)}`);
      return;
    }
    if (message === null || typeof message !== 'object') return;

    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.ok === true) pending.resolve(message.result);
      else pending.reject(new Error(String(message.error ?? '助手调用失败')));
      return;
    }

    if (typeof message.event === 'string') {
      // Events raised before the consumer subscribed (notably `helper.ready`,
      // which the helper emits the moment its server starts listening — always
      // before the host has connected) are buffered rather than dropped.
      if (this.#listeners.size === 0) {
        this.#bufferedEvents.push(message);
        if (this.#bufferedEvents.length > EVENT_BUFFER_LIMIT) this.#bufferedEvents.shift();
        return;
      }
      this.#dispatchEvent(message);
    }
  }

  #dispatchEvent(message) {
    for (const listener of this.#listeners) {
      try {
        listener(message);
      } catch (error) {
        this.#log(`sticky-notes: 事件监听器抛错：${String(error)}`);
      }
    }
  }

  #failAll(error) {
    for (const [, pending] of this.#pending) pending.reject(error);
    this.#pending.clear();
  }

  /**
   * Subscribe to helper push events. Returns an unsubscribe function.
   *
   * Any event that arrived before this first subscription is delivered on a
   * later tick (so the caller can finish wiring up), then the buffer is empty for
   * the rest of the session.
   */
  onEvent(listener) {
    this.#listeners.add(listener);
    if (this.#bufferedEvents.length > 0 && !this.#replaying) {
      this.#replaying = true;
      const pending = this.#bufferedEvents.splice(0, this.#bufferedEvents.length);
      setTimeout(() => {
        this.#replaying = false;
        for (const message of pending) {
          if (this.#listeners.size === 0) break;
          this.#dispatchEvent(message);
        }
      }, 0);
    }
    return () => this.#listeners.delete(listener);
  }

  /** True while the helper process is alive and the RPC socket is open. */
  get alive() {
    return this.#disposed === false && this.#child !== null && this.#ready;
  }

  /**
   * The readiness report the helper returned during the handshake
   * (`{ version, displays, pid, platform }`), or null before `ready()` resolves.
   */
  get readyInfo() {
    return this.#readyInfo;
  }

  #readyInfo = null;

  /**
   * Invoke one helper method.
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs]
   */
  call(method, params = {}, timeoutMs = 15000) {
    if (this.#disposed) return Promise.reject(new Error('Electron 助手已释放'));
    const socket = this.#socket;
    if (!this.#ready || socket === null || socket.destroyed) {
      return Promise.reject(new Error('Electron 助手未运行'));
    }

    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Electron 助手调用超时：${method}`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      try {
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`向 Electron 助手发送失败：${String(error)}`));
      }
    });
  }

  /**
   * Terminate the helper and reject every in-flight call.
   *
   * Asks politely over the socket first (`helper.quit` lets Electron run its own
   * shutdown, releasing the global hotkey), then closes the socket and kills the
   * process as a backstop so a wedged helper cannot outlive DSH.
   */
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;

    if (this.#ready && this.#socket !== null && !this.#socket.destroyed) {
      try {
        await this.call('helper.quit', {}, 3000);
      } catch {
        /* the helper may already be gone */
      }
    }

    const child = this.#child;
    this.#child = null;
    this.#ready = false;
    this.#failAll(new Error('Electron 助手正在关闭'));

    const socket = this.#socket;
    this.#socket = null;
    try {
      socket?.destroy();
    } catch {
      /* ignore */
    }

    if (child === null) return;

    // Wait for the process to actually exit, then make sure it did.
    //
    // This is the difference between a clean restart and a plugin that looks broken
    // afterwards: the helper holds `helper.lock` for its data directory, and a helper
    // that outlives its host keeps that lock — so the *next* helper refuses to start
    // and reports "another helper is using this directory". Observed in practice: an
    // orphaned helper (and its renderers) still running long after the host that
    // spawned it had gone.
    //
    // `child.kill()` alone is not enough here. It sends SIGTERM, which Electron's
    // main process does not treat as "exit now" on Windows, and it leaves the
    // renderer/GPU children behind. `taskkill /T /F` takes the whole tree.
    const exited = await this.#waitForExit(child, 1500);
    if (!exited) await this.#forceKillTree(child);
  }

  /**
   * Resolve true once the child has exited, or false if it is still running.
   * @param {import('node:child_process').ChildProcess} child
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  #waitForExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('exit', onExit);
        resolve(value);
      };
      const onExit = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      child.once('exit', onExit);
    });
  }

  /**
   * Kill the helper and everything it spawned.
   *
   * On Windows the only reliable way to reap an Electron process tree is
   * `taskkill /T /F`; it is a system utility, so there is no dependency to add. If it
   * is unavailable the direct signal is still attempted, so the worst case is the
   * behaviour we had before.
   *
   * @param {import('node:child_process').ChildProcess} child
   */
  async #forceKillTree(child) {
    const pid = child.pid;
    if (typeof pid !== 'number' || pid <= 0) return;
    if (process.platform === 'win32') {
      const killed = await new Promise((resolve) => {
        let settled = false;
        const done = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        try {
          const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.once('error', () => done(false));
          killer.once('exit', (code) => done(code === 0));
        } catch {
          done(false);
        }
      });
      if (killed) return;
    }
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}


