/**
 * Ask the npm registry what the newest published version of this plugin is.
 *
 * ## Why the host does this and not the browser
 *
 * The settings page is served from the DSH web server. A `fetch` from that page to
 * `registry.npmjs.org` is a cross-origin request, and npm's registry does not send CORS headers that
 * would allow reading the response. The host half runs in Node, where no such restriction applies, so
 * the check lives here and the browser reads a plain local route.
 *
 * ## Why it is allowed to fail silently
 *
 * This is a convenience on a settings page. A machine that is offline, behind a proxy, or on a network
 * where the registry is blocked must not see an error, a spinner that never resolves, or a settings page
 * that fails to load. Every failure path resolves to `{ ok: false }`, and the UI simply omits the row.
 *
 * @module dsh-sticky-notes-desktop/lib/host/registry
 */
import { isNewerVersion } from './version.js';

/** How long a successful answer is reused. Long enough that reopening settings does not re-ask. */
const CACHE_MS = 30 * 60 * 1000;

/**
 * How long a *failed* answer is remembered.
 *
 * Shorter than a success: the reason a check failed is usually transient, and a user who has just fixed
 * their network should not have to wait half an hour for the page to try again.
 */
const FAILURE_CACHE_MS = 60 * 1000;

/** Registry request timeout. A settings page must not hang on an unreachable host. */
const TIMEOUT_MS = 6000;

/**
 * The abbreviated packument, which is a fraction of the full document and is exactly what the npm CLI
 * itself asks for. The full document lists every version with every dependency and can be megabytes.
 */
const ACCEPT = 'application/vnd.npm.install-v1+json';

/**
 * @param {object} options
 * @param {string} options.packageName
 * @param {string|null} options.currentVersion
 * @param {string} [options.registry]  Base URL; overridable so a test can point at a local server.
 * @param {(message: string) => void} [options.log]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createVersionChecker(options) {
  const packageName = options.packageName;
  const currentVersion = options.currentVersion ?? null;
  const registry = (options.registry ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
  const log = options.log ?? (() => {});
  // `??` would treat an explicit `null` as "not provided" and fall back to the global `fetch`, which
  // makes it impossible to test the "no fetch available" path — and the test for it failed for exactly
  // that reason. Checking for the property distinguishes "absent" from "deliberately null".
  const fetchImpl = Object.prototype.hasOwnProperty.call(options, 'fetchImpl')
    ? options.fetchImpl
    : globalThis.fetch;

  /** @type {{at: number, value: object}|null} */
  let cached = null;
  /** In-flight request, so several settings-page loads in quick succession share one call. */
  let inFlight = null;

  const isFresh = () => cached !== null && Date.now() - cached.at < (cached.value.ok === true ? CACHE_MS : FAILURE_CACHE_MS);

  /** One registry round trip. Never throws. */
  async function ask() {
    if (typeof fetchImpl !== 'function') {
      return { ok: false, reason: 'no-fetch' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${registry}/${encodeURIComponent(packageName)}`, {
        headers: { accept: ACCEPT },
        redirect: 'follow',
        signal: controller.signal,
      });

      // A 404 means the package is not published (a local or `.tgz` install). That is not an error for
      // the user to see — there is simply nothing to compare against.
      if (response.status === 404) return { ok: false, reason: 'not-published' };
      if (!response.ok) return { ok: false, reason: `http-${response.status}` };

      const body = await response.json();
      const latest = body?.['dist-tags']?.latest;
      if (typeof latest !== 'string' || latest.length === 0) return { ok: false, reason: 'no-dist-tag' };

      return {
        ok: true,
        latest,
        current: currentVersion,
        // Resolved here rather than in the browser: the comparison is the part with edge cases, and
        // keeping it on one side means the UI never has to know how versions are ordered.
        updateAvailable: currentVersion === null ? false : isNewerVersion(latest, currentVersion),
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      const aborted = error !== null && typeof error === 'object' && error.name === 'AbortError';
      return { ok: false, reason: aborted ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /**
     * The latest published version, from cache when possible.
     *
     * @param {boolean} [force]  Skip the cache — what the "check now" control uses.
     */
    async check(force = false) {
      if (force !== true && isFresh()) return cached.value;
      if (inFlight !== null) return inFlight;

      inFlight = ask()
        .then((value) => {
          cached = { at: Date.now(), value };
          if (value.ok !== true) log(`sticky-notes: 检查最新版本失败（${value.reason}）`);
          return value;
        })
        .finally(() => {
          inFlight = null;
        });

      return inFlight;
    },
  };
}
