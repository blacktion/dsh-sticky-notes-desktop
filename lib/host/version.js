/**
 * Version comparison for the settings page's "is there a newer release?" check.
 *
 * Split into its own module because this is the part with real edge cases and no I/O: comparing
 * `0.10.0` against `0.9.0` by string would say 0.9.0 is newer, and a prerelease must never be reported
 * as an upgrade. Keeping it separate means those cases can be tested directly instead of through a
 * network call.
 *
 * @module dsh-sticky-notes-desktop/lib/host/version
 */

/**
 * Parse a version into comparable numeric parts plus its prerelease tag.
 *
 * Anything unparseable yields `null`, and every caller treats `null` as "cannot tell" — never as
 * "older". Guessing would either nag about an update that does not exist or hide one that does.
 *
 * @param {unknown} value
 * @returns {{parts: number[], prerelease: string}|null}
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^v/i, '');
  if (trimmed.length === 0) return null;

  // Split off build metadata (`+sha`) first: it has no effect on precedence.
  const withoutBuild = trimmed.split('+')[0];
  const dash = withoutBuild.indexOf('-');
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const prerelease = dash === -1 ? '' : withoutBuild.slice(dash + 1);

  const fields = core.split('.');
  if (fields.length === 0 || fields.length > 3) return null;

  const parts = [];
  for (const field of fields) {
    if (!/^\d+$/.test(field)) return null;
    parts.push(Number(field));
  }
  while (parts.length < 3) parts.push(0);

  return { parts, prerelease };
}

/**
 * Compare two prerelease strings per semver.
 *
 * Only reached when the numeric releases are equal, which is why the earlier version of this function
 * reported `0.2.0-rc.2` as *not* newer than `0.2.0-rc.1` — it compared the numbers, found them equal and
 * stopped. Someone already on a prerelease is legitimately behind the next prerelease, so that case has
 * to be ordered rather than ignored.
 *
 * @returns {number} negative when `a` is older, positive when newer.
 */
function comparePrerelease(a, b) {
  // No prerelease outranks one: `0.2.0` > `0.2.0-rc.1`.
  if (a === '' && b === '') return 0;
  if (a === '') return 1;
  if (b === '') return -1;

  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i];
    const y = right[i];
    // A shorter set of identifiers is older when all the preceding ones match.
    if (x === undefined) return -1;
    if (y === undefined) return 1;

    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const dx = Number(x) - Number(y);
      if (dx !== 0) return dx < 0 ? -1 : 1;
      continue;
    }
    // Numeric identifiers always sort below alphanumeric ones.
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Is `candidate` a strictly newer release than `current`?
 *
 * A prerelease candidate is never an upgrade from a plain release: `0.2.0-rc.1` on top of `0.1.0` would
 * be offered as a normal release, and installing it is rarely what someone pressing "update" wants.
 * A prerelease *current* version is compared normally, because someone already on a prerelease is
 * legitimately behind a newer prerelease.
 *
 * @param {unknown} candidate
 * @param {unknown} current
 * @returns {boolean}
 */
export function isNewerVersion(candidate, current) {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (next === null || now === null) return false;
  if (next.prerelease !== '' && now.prerelease === '') return false;

  for (let i = 0; i < 3; i += 1) {
    if (next.parts[i] > now.parts[i]) return true;
    if (next.parts[i] < now.parts[i]) return false;
  }

  // Same numeric release: only a higher prerelease of it counts.
  return comparePrerelease(next.prerelease, now.prerelease) > 0;
}
