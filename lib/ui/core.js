/**
 * dsh-sticky-notes — client-side constants and tiny helpers.
 *
 * Bundle contract: this file is concatenated into `lib/client.bundle.js` by
 * `tools/build-client.mjs`, so it must stay a plain script — no `import`, no
 * `export`, no top-level `require`. Everything it defines hangs off the shared
 * `__dshSticky` namespace so `lib/ui/*.js` can reach it after concatenation.
 *
 * @module dsh-sticky-notes/client/core
 */
(function () {
  'use strict';

  var NS = (globalThis.__dshSticky = globalThis.__dshSticky || {});

  /** Must match `package.json`'s `name`: the browser loader keys on it. */
  NS.PACKAGE = 'dsh-sticky-notes-desktop';

  /** Locale namespace registered with DSH's locale service. */
  NS.LOCALE_NS = 'sticky-notes';

  /**
   * The name that carries the package name, e.g. `便签（dsh-sticky-notes-desktop）`.
   *
   * Used **only** for the plugin-list card, where several plugins sit side by side and a bare
   * 「便签」 would not say which one this is — `dsh-sticky-notes` is a real, unrelated sticky-notes
   * package on npm. The sidebar and the settings page deliberately use the short names: there the
   * user is already inside this plugin, so the package name is noise.
   *
   * Note this is *not* the only literal. `locale/zh.json` has to spell the same string out,
   * because DSH reads that JSON to render the plugin card before any of this code runs.
   */
  NS.displayName = function displayName() {
    return '便签（' + NS.PACKAGE + '）';
  };

  /**
   * Why the sidebar and settings labels are *not* {@link NS.displayName}.
   *
   * A rename cannot break them: they resolve through the locale dictionary below, so the package
   * name never appears in them. That is the point — the previous version had the bracketed name in
   * three places and a rename silently left the sidebar stale.
   */
  NS.PLAIN_NAME_KEY = 'panel.title';
  NS.SETTINGS_NAME_KEY = 'settings.nav';

  /**
   * Key of our centre-column panel; also the `sidebar.panellist` id.
   *
   * Deliberately *not* the package name: it only has to be unique among registered slots, and
   * the locale namespace (`sticky-notes`) and settings id already use this shorter form. Keeping
   * a UI key tied to the package name would mean every rename breaks persisted slot identity.
   */
  NS.PANEL_ID = 'sticky-notes';

  /** Settings page id. */
  NS.SETTINGS_ID = 'sticky-notes';

  /** Base path of the host's JSON surface. */
  NS.API = '/plugins/dsh-sticky-notes-desktop';

  /**
   * Palette offered by the settings page and the note colour button.
   *
   * Black leads because it is the default background; it also has to be present
   * for the settings page to render the active swatch as selected.
   */
  NS.PALETTE = [
    '#000000',
    '#fff3b0',
    '#c8e6c9',
    '#bbdefb',
    '#f8bbd0',
    '#ffe0b2',
    '#e1bee7',
    '#ffffff',
  ];

  /**
   * `fetch` against our own routes.
   *
   * Always resolves — a transport failure becomes `{ error }` — because every
   * caller is a React effect or event handler where a rejection would surface as
   * an unhandled error inside DSH's shell.
   *
   * @param {string} path
   * @param {object} [init]
   * @returns {Promise<object>}
   */
  NS.api = function api(path, init) {
    var options = { credentials: 'same-origin', headers: {} };
    if (init !== undefined && init !== null) {
      if (init.method !== undefined) options.method = init.method;
      if (init.body !== undefined) {
        options.method = options.method || 'POST';
        options.headers['content-type'] = 'application/json';
        options.body = JSON.stringify(init.body);
      }
    }
    return fetch(NS.API + path, options)
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return {};
          })
          .then(function (payload) {
            if (!response.ok) {
              var message = payload && payload.error ? payload.error : 'HTTP ' + response.status;
              return { error: message, status: response.status };
            }
            return payload;
          });
      })
      .catch(function (error) {
        return { error: String((error && error.message) || error) };
      });
  };

  /**
   * Pull a printable accelerator out of whatever the host reported.
   *
   * The host sends the accelerator string, but older/other shapes send the
   * registration outcome (`{ ok, hotkey }`). Both must render sensibly — the one
   * thing that must never happen is `[object Object]` in the settings UI.
   *
   * @param {unknown} value
   * @returns {string} accelerator, or '' when there is nothing to show
   */
  NS.hotkeyText = function hotkeyText(value) {
    if (typeof value === 'string') return value;
    if (value !== null && typeof value === 'object' && typeof value.hotkey === 'string') return value.hotkey;
    return '';
  };

  /**
   * Human-readable accelerator for display: `CommandOrControl+Alt+S` → `Ctrl + Alt + S`.
   *
   * Shared so the panel footer and the settings page never disagree about how the
   * same hotkey reads.
   *
   * @param {unknown} value accelerator, or a registration outcome containing one
   * @returns {string}
   */
  NS.prettyHotkey = function prettyHotkey(value) {
    var accelerator = NS.hotkeyText(value);
    if (accelerator.length === 0) return '';
    return accelerator
      .replace('CommandOrControl', 'Ctrl')
      .replace('Command', 'Cmd')
      .split('+')
      .join(' + ');
  };

  /** `#rrggbb` + alpha → `rgba(...)`, for note previews. */
  NS.withAlpha = function withAlpha(hex, alpha) {
    var value = typeof hex === 'string' ? hex.replace('#', '') : '';
    if (value.length === 3) {
      value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2];
    }
    if (value.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(value)) return 'rgba(255, 243, 176, ' + alpha + ')';
    var r = parseInt(value.slice(0, 2), 16);
    var g = parseInt(value.slice(2, 4), 16);
    var b = parseInt(value.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  };

  /** Short, human-readable time for a note list row. */
  NS.formatTime = function formatTime(iso) {
    if (typeof iso !== 'string' || iso.length === 0) return '';
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    var pad = function (n) {
      return n < 10 ? '0' + n : String(n);
    };
    return (
      date.getFullYear() +
      '-' +
      pad(date.getMonth() + 1) +
      '-' +
      pad(date.getDate()) +
      ' ' +
      pad(date.getHours()) +
      ':' +
      pad(date.getMinutes())
    );
  };

  /** First non-empty line of a note, for a list row's preview text. */
  NS.previewOf = function previewOf(note) {
    if (note === null || note === undefined) return '';
    var source = typeof note.title === 'string' && note.title.length > 0 ? note.title : note.text;
    if (typeof source !== 'string' || source.length === 0) return '';
    var line = source.split('\n').find(function (part) {
      return part.trim().length > 0;
    });
    return (line || '').trim();
  };
  /**
   * When an alarm will next ring, as a short list-row phrase.
   *
   * `nextAt` arrives as an ISO instant from the host, which computed it against its own clock
   * and timezone — the browser's clock can differ, so the host is the only authority on
   * "next". The instant is then rendered in the browser's local time, which is what the user
   * reads their other clocks in.
   *
   * @param {string|null} iso
   * @param {boolean} enabled
   */
  NS.formatAlarmNext = function formatAlarmNext(iso, enabled) {
    if (enabled === false) return '';
    if (typeof iso !== 'string' || iso.length === 0) return '';
    var when = new Date(iso);
    if (isNaN(when.getTime())) return '';

    var pad = function (n) {
      return n < 10 ? '0' + n : String(n);
    };
    var now = new Date();
    var sameDay =
      when.getFullYear() === now.getFullYear() &&
      when.getMonth() === now.getMonth() &&
      when.getDate() === now.getDate();
    var time = pad(when.getHours()) + ':' + pad(when.getMinutes());
    if (sameDay) return '今天 ' + time;

    var tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    var isTomorrow =
      when.getFullYear() === tomorrow.getFullYear() &&
      when.getMonth() === tomorrow.getMonth() &&
      when.getDate() === tomorrow.getDate();
    if (isTomorrow) return '明天 ' + time;

    return pad(when.getMonth() + 1) + '-' + pad(when.getDate()) + ' ' + time;
  };
})();
