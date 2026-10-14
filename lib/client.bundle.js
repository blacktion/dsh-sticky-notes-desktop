/**
 * dsh-sticky-notes-desktop — GENERATED browser bundle. DO NOT EDIT.
 *
 * Built by `tools/build-client.mjs` from:
 *   - lib/ui/core.js
 *   - lib/ui/panel.js
 *   - lib/ui/settings.js
 *   - lib/client.js
 *
 * Edit those sources and re-run `node tools/build-client.mjs`.
 */

// ==================== lib/ui/core.js ====================
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

// ==================== lib/ui/panel.js ====================
/**
 * dsh-sticky-notes — the notes panel (sidebar entry + centre column).
 *
 * Registered twice from `lib/client.js`:
 *   - `sidebar.panellist` gets {@link PanelIcon}, the rail button,
 *   - `main` (keyed by the same id) gets {@link NotesPanel}, the full page.
 *
 * Bundle contract: plain script, concatenated. No imports.
 *
 * @module dsh-sticky-notes/client/panel
 */
(function () {
  'use strict';

  var NS = (globalThis.__dshSticky = globalThis.__dshSticky || {});
  var h = null;

  /** Called once by the bundle entry, after React is required. */
  NS.initPanel = function initPanel(React) {
    h = React.createElement;
  };

  /** Always call the freshest `h`; the bundle assigns it before first render. */
  function el() {
    return h.apply(null, arguments);
  }

  var panelStyles = [
    '.dsn-panel{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px}',
    '.dsn-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsh-border,rgba(128,128,128,.22));flex:0 0 auto}',
    '.dsn-head h2{margin:0;font-size:14px;font-weight:600;flex:1 1 auto}',
    '.dsn-count{opacity:.6;font-weight:400;font-size:12px}',
    '.dsn-btn{border:1px solid var(--dsh-border,rgba(128,128,128,.3));background:transparent;color:inherit;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;line-height:1.6}',
    '.dsn-btn:hover{background:rgba(128,128,128,.14)}',
    '.dsn-btn.primary{background:var(--dsh-accent,#4a7dff);border-color:transparent;color:#fff}',
    '.dsn-btn.primary:hover{filter:brightness(1.08)}',
    // The delete button is the one destructive action in the row; it needs to read as such
    // now that it sits inline with the others rather than at the bottom of a column.
    '.dsn-btn.danger{border-color:rgba(248,81,73,.5);color:#f85149}',
    '.dsn-btn.danger:hover{background:rgba(248,81,73,.16)}',
    '.dsn-btn[disabled]{opacity:.45;cursor:default}',
    '.dsn-body{flex:1 1 auto;overflow:auto;padding:8px}',
    // Tabs: one sidebar entry, two lists (便签 / 便签闹钟).
    '.dsn-tabs{flex:0 0 auto;display:flex;gap:2px;padding:6px 8px 0}',
    '.dsn-tab{flex:1 1 0;min-width:0;border:0;border-bottom:2px solid transparent;background:transparent;color:inherit;opacity:.6;font:inherit;font-size:12px;padding:5px 4px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dsn-tab:hover{opacity:.85}',
    '.dsn-tab.on{opacity:1;font-weight:600;border-bottom-color:var(--dsh-accent,#4a7dff)}',
    '.dsn-seg{display:flex;gap:4px;flex-wrap:wrap}',
    '.dsn-hintline{font-size:11px;opacity:.55;line-height:1.5}',
    // The "use 试响 to choose where it appears" hint. Boxed so it reads as a deliberate
    // instruction rather than more small print, since it is the only way to discover the
    // feature.
    '.dsn-poshint{display:flex;flex-direction:column;gap:4px;padding:7px 9px;border-radius:6px;background:rgba(74,125,255,.12);border:1px solid rgba(74,125,255,.34);font-size:11px;line-height:1.6}',
    '.dsn-poshint-text{opacity:.92}',
    '.dsn-poshint-where{display:flex;align-items:center;gap:6px;opacity:.75;font-variant-numeric:tabular-nums}',
    '.dsn-poshint-where .dsn-btn{padding:1px 6px;font-size:11px}',
    '.dsn-path{flex:1 1 auto;min-width:0;font-size:11px;opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}',
    // A ringing alarm is the one row that must be findable at a glance.
    '.dsn-alarm-ringing .dsn-row{background:rgba(255,176,32,.13);border-color:rgba(255,176,32,.5)}',
    '.dsn-tag.ringing{background:rgba(255,176,32,.25);border-color:rgba(255,176,32,.8);opacity:.95}',
    '.dsn-alarm-glyph{font-size:22px;line-height:1;opacity:.85}',
    '.dsn-edit .dsn-lab input[type="time"],.dsn-edit .dsn-lab input[type="datetime-local"]{flex:1 1 auto;min-width:0;box-sizing:border-box;background:rgba(128,128,128,.08);color:inherit;border:1px solid var(--dsh-border,rgba(128,128,128,.3));border-radius:6px;padding:5px 7px;font:inherit;font-size:13px}',
    '.dsn-empty{padding:28px 16px;text-align:center;opacity:.62;line-height:1.9}',
    '.dsn-banner{margin:8px;padding:8px 10px;border-radius:6px;background:rgba(255,170,0,.14);border:1px solid rgba(255,170,0,.35);line-height:1.7;font-size:12px}',
    '.dsn-banner.err{background:rgba(255,80,80,.12);border-color:rgba(255,80,80,.35)}',
    // `position:relative` anchors the hover-revealed actions to the row.
    '.dsn-row{position:relative;display:flex;gap:10px;align-items:flex-start;padding:8px;border-radius:8px;border:1px solid transparent}',
    '.dsn-row:hover{background:rgba(128,128,128,.1);border-color:var(--dsh-border,rgba(128,128,128,.22))}',
    '.dsn-thumb{flex:0 0 auto;width:54px;height:44px;border-radius:6px;overflow:hidden;display:flex;align-items:center;justify-content:center;border:1px solid rgba(128,128,128,.3)}',
    '.dsn-thumb img{width:100%;height:100%;object-fit:cover;display:block}',
    '.dsn-txt{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px}',
    '.dsn-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dsn-prev{opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;min-height:1.2em}',
    // Last line of the row: tags and timestamp, left-aligned, costing no extra height.
    '.dsn-foot-row{display:flex;align-items:center;gap:8px;min-height:22px}',
    '.dsn-meta{display:flex;gap:6px;align-items:center;font-size:11px;opacity:.55;flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap}',
    '.dsn-time{flex:0 0 auto}',
    '.dsn-tag{border:1px solid currentColor;border-radius:10px;padding:0 6px;line-height:1.5;flex:0 0 auto}',
    // Buttons overlay the row's bottom-right corner and only appear on hover, so they cost
    // the text block no width. The sidebar is ~320px: four permanent inline buttons left the
    // title truncated to "(无...". Shown on focus-within too, so they stay reachable by
    // keyboard, and always shown on a touch device where hover never happens.
    '.dsn-acts{position:absolute;right:8px;bottom:6px;display:flex;flex-direction:row;gap:4px;align-items:center;opacity:0;pointer-events:none;transition:opacity .12s ease;padding:2px 0 2px 8px;border-radius:6px}',
    '.dsn-row:hover .dsn-acts,.dsn-row:focus-within .dsn-acts{opacity:1;pointer-events:auto}',
    '@media (hover:none){.dsn-acts{opacity:1;pointer-events:auto;position:static;justify-content:flex-end}}',
    '.dsn-acts .dsn-btn{padding:2px 7px;font-size:11px;line-height:1.6;white-space:nowrap}',
    '.dsn-edit{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--dsh-border,rgba(128,128,128,.3));border-radius:8px;margin-bottom:8px}',
    '.dsn-edit textarea,.dsn-edit input{width:100%;box-sizing:border-box;background:rgba(128,128,128,.08);color:inherit;border:1px solid var(--dsh-border,rgba(128,128,128,.3));border-radius:6px;padding:6px 8px;font:inherit;font-size:13px}',
    '.dsn-edit textarea{min-height:96px;resize:vertical}',
    '.dsn-swatches{display:flex;gap:6px;flex-wrap:wrap}',
    '.dsn-swatch{width:22px;height:22px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0}',
    '.dsn-swatch[data-on="1"]{border-color:var(--dsh-accent,#4a7dff)}',
    '.dsn-lab{display:flex;align-items:center;gap:8px;font-size:12px}',
    '.dsn-lab span:first-child{opacity:.7;min-width:52px}',
    '.dsn-foot{flex:0 0 auto;padding:8px 12px;border-top:1px solid var(--dsh-border,rgba(128,128,128,.22));font-size:11px;opacity:.6;display:flex;gap:10px;align-items:center}',
    '.dsn-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}',
  ].join('');

  /** Rail icon: a small note glyph. */
  function PanelIcon() {
    return el(
      'svg',
      { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
      el('path', { d: 'M15 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l5-5V5a2 2 0 0 0-2-2z' }),
      el('path', { d: 'M14 21v-4a2 2 0 0 1 2-2h4' }),
      el('path', { d: 'M8 8h7M8 12h5' }),
    );
  }

  /**
   * The full-page notes panel.
   *
   * @param {object} props  slot props supplied by DSH
   */
  function NotesPanel(props) {
    var t = props && typeof props.t === 'function' ? props.t : function (key) { return key; };
    var React = NS.React;
    if (React === undefined) return null;

    var stateHook = React.useState({ notes: [], settings: null, helper: null, error: null, loading: true });
    var state = stateHook[0];
    var setState = stateHook[1];

    var editingHook = React.useState(null);
    var editing = editingHook[0];
    var setEditing = editingHook[1];

    var busyHook = React.useState(null);
    var busy = busyHook[0];
    var setBusy = busyHook[1];

    var draftHook = React.useState({ text: '', title: '', color: null, opacity: null });
    var draft = draftHook[0];
    var setDraft = draftHook[1];

    // Which of the two lists is showing. The sidebar entry opens the notes list, as before;
    // 便签闹钟 is a second tab rather than a second sidebar entry so the plugin keeps one
    // entry per the sidebar contract.
    var tabHook = React.useState('notes');
    var tab = tabHook[0];
    var setTab = tabHook[1];

    /** The alarm being edited, or null. Held here so a poll cannot discard typing. */
    var alarmDraftHook = React.useState(null);
    var alarmDraft = alarmDraftHook[0];
    var setAlarmDraft = alarmDraftHook[1];

    /** Pull the whole snapshot. Never throws. */
    var refresh = React.useCallback(function () {
      return NS.api('/state').then(function (payload) {
        if (payload && payload.error) {
          setState(function (prev) {
            return Object.assign({}, prev, { error: payload.error, loading: false });
          });
          return;
        }
        setState({
          notes: Array.isArray(payload.notes) ? payload.notes : [],
          alarms: Array.isArray(payload.alarms) ? payload.alarms : [],
          settings: payload.settings || null,
          helper: payload.helper || null,
          error: null,
          loading: false,
        });
      });
    }, []);

    React.useEffect(function () {
      var alive = true;
      refresh();
      // A note created by the hotkey, or dragged against an edge, is persisted by the
      // host while the user works — there is no socket to push it, so a poll keeps the
      // list honest. Kept short because a note the user just created with the hotkey
      // is expected to show up straight away; a long interval read as "it is missing".
      var timer = setInterval(function () {
        if (alive) refresh();
      }, 1500);
      return function () {
        alive = false;
        clearInterval(timer);
      };
    }, [refresh]);

    /**
     * While an alarm editor is open, pick up any position the user dragged its 试响 popup to.
     *
     * Separate from the list poll above and faster, because the popup is open *right now*: the
     * user is dragging it and expects the editor to reflect where they left it. Only runs while
     * an editor exists, so it costs nothing the rest of the time.
     */
    React.useEffect(
      function () {
        if (alarmDraft === null) return undefined;
        var alive = true;
        var open = true;
        var timer = setInterval(function () {
          if (alive && open) syncDraftPosition();
        }, 700);
        return function () {
          alive = false;
          open = false;
          clearInterval(timer);
        };
      },
      [alarmDraft === null, syncDraftPosition],
    );

    var createNote = function () {
      setBusy('create');
      NS.api('/notes', { method: 'POST', body: { kind: 'text', text: '', title: '' } })
        .then(function () {
          return refresh();
        })
        .finally(function () {
          setBusy(null);
        });
    };

    var openNote = function (id) {
      setBusy(id);
      NS.api('/notes/open', { method: 'POST', body: { id: id } })
        .then(function (payload) {
          if (payload && payload.error) {
            setState(function (prev) {
              return Object.assign({}, prev, { error: payload.error });
            });
          } else if (payload && payload.ok !== true && payload.error) {
            setState(function (prev) {
              return Object.assign({}, prev, { error: payload.error });
            });
          }
          return refresh();
        })
        .finally(function () {
          setBusy(null);
        });
    };

    var startEdit = function (note) {
      setEditing(note.id);
      setDraft({
        text: typeof note.text === 'string' ? note.text : '',
        title: typeof note.title === 'string' ? note.title : '',
        color: note.color,
        opacity: note.opacity,
      });
    };

    var saveEdit = function (id) {
      setBusy(id);
      var patch = { text: draft.text, title: draft.title };
      if (draft.color !== null) patch.color = draft.color;
      if (draft.opacity !== null) patch.opacity = draft.opacity;
      NS.api('/notes', { method: 'PATCH', body: { id: id, patch: patch } })
        .then(function () {
          setEditing(null);
          return refresh();
        })
        .finally(function () {
          setBusy(null);
        });
    };

    var removeNote = function (id) {
      setBusy(id);
      NS.api('/notes?id=' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function () {
          return refresh();
        })
        .finally(function () {
          setBusy(null);
        });
    };

    /**
     * Toggle "keep this note out" from the list.
     *
     * The same control the note's own button drives, so the two can never disagree:
     * both go through `POST /notes/pin`, which persists the flag and tells the
     * helper.
     */
    var pinNote = function (note) {
      setBusy(note.id);
      NS.api('/notes/pin', { method: 'POST', body: { id: note.id, pinned: note.pinned !== true } })
        .then(function () {
          return refresh();
        })
        .finally(function () {
          setBusy(null);
        });
    };

    // ------------------------------------------------------------- 便签闹钟

    /** A blank alarm, defaulted to a daily 09:00 so the form is usable immediately. */
    var emptyAlarm = function () {
      return {
        id: null,
        label: '',
        kind: 'text',
        text: '',
        image: null,
        schedule: { kind: 'daily', time: '09:00', at: '' },
        enabled: true,
        // null ⇒ let the host centre it; set by dragging the 试响 popup.
        x: null,
        y: null,
      };
    };

    var startNewAlarm = function () {
      setAlarmDraft(emptyAlarm());
    };

    var startEditAlarm = function (alarm) {
      setAlarmDraft({
        id: alarm.id,
        label: alarm.label || '',
        kind: alarm.kind === 'image' ? 'image' : 'text',
        text: alarm.text || '',
        image: alarm.image || null,
        schedule: {
          kind: alarm.schedule?.kind || 'daily',
          time: alarm.schedule?.time || '09:00',
          at: alarm.schedule?.at || '',
        },
        enabled: alarm.enabled !== false,
        x: Number.isFinite(Number(alarm.x)) ? Number(alarm.x) : null,
        y: Number.isFinite(Number(alarm.y)) ? Number(alarm.y) : null,
      });
    };

    var patchAlarmDraft = function (patch) {
      setAlarmDraft(function (prev) {
        return prev === null ? prev : Object.assign({}, prev, patch);
      });
    };

    var patchAlarmSchedule = function (patch) {
      setAlarmDraft(function (prev) {
        if (prev === null) return prev;
        return Object.assign({}, prev, { schedule: Object.assign({}, prev.schedule, patch) });
      });
    };

    /** Save the alarm being edited. Creating and updating are the same call. */
    var saveAlarm = function () {
      if (alarmDraft === null) return;
      var body = {
        label: alarmDraft.label,
        kind: alarmDraft.kind,
        text: alarmDraft.text,
        image: alarmDraft.image,
        schedule: alarmDraft.schedule,
        enabled: alarmDraft.enabled !== false,
        // Saved so the alarm appears where the user positioned it with 试响.
        x: alarmDraft.x,
        y: alarmDraft.y,
      };
      setBusy('alarm');
      // PATCH when it has an id, POST when it does not — the host treats them differently
      // (one merges onto an existing record, the other creates one).
      var request = alarmDraft.id === null
        ? NS.api('/alarms', { method: 'POST', body: body })
        : NS.api('/alarms', { method: 'PATCH', body: { id: alarmDraft.id, patch: body } });
      request
        .then(function (payload) {
          if (payload && payload.error) throw new Error(String(payload.error));
          setAlarmDraft(null);
          return refresh();
        })
        .catch(function (error) {
          setState(function (prev) {
            return Object.assign({}, prev, { error: '保存闹钟失败：' + String(error && error.message ? error.message : error) });
          });
        })
        .finally(function () {
          setBusy(null);
        });
    };

    /**
     * 试响 — ring this alarm now, ignoring its schedule.
     *
     * Doubles as the position picker: the popup can be dragged, and the position it is left at
     * is what gets saved. Both the editor and the 「新建闹钟」 form go through here, because the
     * moment a user most wants to place the popup is before they have saved anything.
     */
    var testRing = function () {
      if (alarmDraft === null) return;
      var hasId = typeof alarmDraft.id === 'string' && alarmDraft.id.length > 0;
      setBusy('ring');
      NS.api('/alarms/ring', {
        method: 'POST',
        // No id ⇒ the host previews this draft. That is what makes 试响 available on a brand
        // new alarm, when there is no record to point at yet.
        body: hasId
          ? { id: alarmDraft.id }
          : {
              label: alarmDraft.label,
              kind: alarmDraft.kind,
              text: alarmDraft.text,
              image: alarmDraft.image,
              x: alarmDraft.x,
              y: alarmDraft.y,
            },
      })
        .then(function (payload) {
          if (payload && payload.error) throw new Error(String(payload.error));
          // Adopt the position the popup was left at, so saving keeps the place the user chose
          // and a second 试响 opens there rather than back in the centre.
          if (payload && payload.position) {
            patchAlarmDraft({ x: payload.position.x, y: payload.position.y });
          }
          return refresh();
        })
        .catch(function (error) {
          setState(function (prev) {
            return Object.assign({}, prev, {
              error: '试响失败：' + String(error && error.message ? error.message : error),
            });
          });
        })
        .finally(function () {
          setBusy(null);
        });
    };

    /**
     * Take the position from a drag that happened while the popup was open.
     *
     * Polled rather than pushed: the drag happens in the helper, and the panel already polls
     * for its own state. Without this, the position the user just chose would only be picked up
     * by the next 试响.
     */
    var syncDraftPosition = React.useCallback(function () {
      return NS.api('/alarms/position')
        .then(function (payload) {
          if (!payload || !payload.position) return;
          setAlarmDraft(function (prev) {
            if (prev === null) return prev;
            if (prev.x === payload.position.x && prev.y === payload.position.y) return prev;
            return Object.assign({}, prev, { x: payload.position.x, y: payload.position.y });
          });
        })
        .catch(function () {
          /* a missing position is not worth surfacing as an error */
        });
    }, []);

    var clearAlarmPosition = function () {
      patchAlarmDraft({ x: null, y: null });
    };

    var removeAlarm = function (id) {
      setBusy(id);
      NS.api('/alarms?id=' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function () {
          if (alarmDraft !== null && alarmDraft.id === id) setAlarmDraft(null);
          return refresh();
        })
        .finally(function () {
          setBusy(null);
        });
    };

    /** Ring now, ignoring the schedule — so the user can check what it will look like. */
    var ringAlarm = function (id) {
      setBusy(id);
      NS.api('/alarms/ring', { method: 'POST', body: { id: id } })
        .then(function () {
          return refresh();
        })
        .finally(function () {
          setBusy(null);
        });
    };

    var dismissAlarm = function (id) {
      setBusy(id);
      NS.api('/alarms/dismiss', { method: 'POST', body: { id: id } })
        .then(function () {
          return refresh();
        })
        .finally(function () {
          setBusy(null);
        });
    };

    var toggleAlarmEnabled = function (alarm) {
      setBusy(alarm.id);
      NS.api('/alarms', {
        method: 'PATCH',
        body: { id: alarm.id, patch: { enabled: alarm.enabled !== true } },
      })
        .then(function () {
          return refresh();
        })
        .finally(function () {
          setBusy(null);
        });
    };

    /** Open the native picker for an image alarm. */
    var pickAlarmImage = function () {
      setBusy('pick');
      NS.api('/alarms/pick-image', { method: 'POST' })
        .then(function (payload) {
          if (payload && payload.error) throw new Error(String(payload.error));
          if (typeof payload.path === 'string' && payload.path.length > 0) {
            patchAlarmDraft({ image: payload.path, kind: 'image' });
          }
        })
        .catch(function (error) {
          setState(function (prev) {
            return Object.assign({}, prev, { error: '选择图片失败：' + String(error && error.message ? error.message : error) });
          });
        })
        .finally(function () {
          setBusy(null);
        });
    };

    var takeShot = function () {
      setBusy('shot');
      // The annotation window is interactive and can stay open a while, so this
      // request only resolves once the user commits or cancels.
      NS.api('/capture', { method: 'POST', body: { mode: 'note' } })
        .then(function (payload) {
          if (payload && payload.error) {
            setState(function (prev) {
              return Object.assign({}, prev, { error: payload.error });
            });
            return null;
          }
          return refresh();
        })
        .finally(function () {
          setBusy(null);
        });
    };

    // ------------------------------------------------------------- rendering

    var helper = state.helper;
    var helperDown = helper !== null && helper !== undefined && helper.running !== true;

    var banner = null;
    if (helperDown) {
      banner = el(
        'div',
        { className: 'dsn-banner' },
        t('panel.helperDown'),
        helper && helper.error ? el('div', { style: { opacity: 0.75, marginTop: 4 } }, String(helper.error)) : null,
      );
    }
    if (state.error) {
      banner = el('div', { className: 'dsn-banner err' }, String(state.error));
    }

    var rows = state.notes.map(function (note) {
      var isEditing = editing === note.id;
      var isBusy = busy === note.id;

      var thumb = el(
        'div',
        { className: 'dsn-thumb', style: { background: NS.withAlpha(note.color, 1) } },
        note.kind === 'shot' ? el('img', { src: NS.API + '/image?id=' + encodeURIComponent(note.id), alt: '' }) : null,
      );

      // Buttons run in a single row, not a column.
      //
      // Four stacked buttons were the actual cause of the tall, cramped rows: the column
      // was ~4x a button tall, so the row could never be shorter than that no matter how
      // narrow the text was. Laid out horizontally they fit on one line under the text.
      // Short labels keep them from wrapping, since the sidebar is narrow.
      var actions = el(
        'div',
        { className: 'dsn-acts' },
        el('button', { className: 'dsn-btn', disabled: isBusy, title: t('panel.open'), onClick: function () { openNote(note.id); } }, t('panel.open')),
        el('button', { className: 'dsn-btn', disabled: isBusy, title: t('panel.edit'), onClick: function () { (isEditing ? setEditing(null) : startEdit(note)); } }, isEditing ? t('panel.cancel') : t('panel.edit')),
        el('button', { className: 'dsn-btn', disabled: isBusy, title: note.pinned === true ? t('panel.unpin') : t('panel.pin'), onClick: function () { pinNote(note); } }, note.pinned === true ? t('panel.unpin') : t('panel.pin')),
        el('button', { className: 'dsn-btn danger', disabled: isBusy, title: t('panel.delete'), onClick: function () { removeNote(note.id); } }, t('panel.delete')),
      );

      var body = el(
        'div',
        { className: 'dsn-txt' },
        el('div', { className: 'dsn-title' }, NS.previewOf(note) || t('panel.untitled')),
        // A screenshot's content is the thumbnail; a second line saying "截图" wastes the
        // row's scarcest resource, so the preview line is only drawn when there is text.
        note.kind === 'shot' ? null : el('div', { className: 'dsn-prev' }, (note.text || '').split('\n').slice(1).join(' ').slice(0, 80)),
        // Tags and timestamp on the row's last line. The buttons are rendered *after* the
        // text block and overlay this line's right end on hover (see `.dsn-acts`), rather
        // than occupying width permanently: at a real sidebar width (~320px) four inline
        // buttons ate the entire line and truncated the title to "(无...".
        el(
          'div',
          { className: 'dsn-foot-row' },
          el(
            'div',
            { className: 'dsn-meta' },
            el('span', { className: 'dsn-tag' }, note.kind === 'shot' ? t('panel.kindShot') : t('panel.kindText')),
            note.pinned === true ? el('span', { className: 'dsn-tag' }, t('panel.pinnedTag')) : null,
            note.hidden ? el('span', { className: 'dsn-tag' }, t('panel.hiddenTag')) : null,
            el('span', { className: 'dsn-time' }, NS.formatTime(note.updatedAt || note.createdAt)),
          ),
        ),
      );

      var editor = null;
      if (isEditing) {
        editor = el(
          'div',
          { className: 'dsn-edit' },
          el('input', {
            value: draft.title,
            placeholder: t('panel.titlePlaceholder'),
            onChange: function (event) { setDraft(Object.assign({}, draft, { title: event.target.value })); },
          }),
          el('textarea', {
            value: draft.text,
            placeholder: t('panel.textPlaceholder'),
            onChange: function (event) { setDraft(Object.assign({}, draft, { text: event.target.value })); },
          }),
          el(
            'div',
            { className: 'dsn-lab' },
            el('span', null, t('settings.backgroundColor')),
            el(
              'div',
              { className: 'dsn-swatches' },
              NS.PALETTE.map(function (color) {
                return el('button', {
                  key: color,
                  className: 'dsn-swatch',
                  'data-on': (draft.color || note.color) === color ? '1' : '0',
                  style: { background: color },
                  title: color,
                  onClick: function () { setDraft(Object.assign({}, draft, { color: color })); },
                });
              }),
            ),
          ),
          el(
            'div',
            { className: 'dsn-lab' },
            el('span', null, t('settings.opacity')),
            el('input', {
              type: 'range',
              min: 0.2,
              max: 1,
              step: 0.05,
              value: draft.opacity === null ? note.opacity : draft.opacity,
              onChange: function (event) { setDraft(Object.assign({}, draft, { opacity: Number(event.target.value) })); },
            }),
          ),
          el(
            'div',
            { style: { display: 'flex', gap: 6 } },
            el('button', { className: 'dsn-btn primary', disabled: isBusy, onClick: function () { saveEdit(note.id); } }, t('panel.save')),
            el('button', { className: 'dsn-btn', onClick: function () { setEditing(null); } }, t('panel.cancel')),
          ),
        );
      }

      // The actions come last so they can be absolutely positioned over the row's bottom-right
      // corner without affecting the text block's width.
      return el('div', { key: note.id }, isEditing ? editor : null, el('div', { className: 'dsn-row' }, thumb, body, actions));
    });

    // ------------------------------------------------------- 便签闹钟 列表

    var alarmRows = (state.alarms || []).map(function (alarm) {
      var isBusy = busy === alarm.id;
      var isImage = alarm.kind === 'image';
      var nextText = NS.formatAlarmNext(alarm.nextAt, alarm.enabled);

      // Only fetch an image when there is one. `kind` is not enough on its own: switching an
      // alarm from image to text leaves the old path behind, and an `<img>` pointing at it
      // would 404 on every poll.
      var hasImage = isImage && typeof alarm.image === 'string' && alarm.image.length > 0;
      var thumb = el(
        'div',
        { className: 'dsn-thumb' },
        hasImage
          ? el('img', { src: NS.API + '/alarm-image?id=' + encodeURIComponent(alarm.id), alt: '' })
          : el('span', { className: 'dsn-alarm-glyph' }, '⏰'),
      );

      var actions = el(
        'div',
        { className: 'dsn-acts' },
        el('button', { className: 'dsn-btn', disabled: isBusy, title: t('alarm.ringNow'), onClick: function () { ringAlarm(alarm.id); } }, t('alarm.ringNow')),
        el('button', { className: 'dsn-btn', disabled: isBusy, title: t('alarm.edit'), onClick: function () { startEditAlarm(alarm); } }, t('alarm.edit')),
        el('button', { className: 'dsn-btn', disabled: isBusy, title: t('alarm.toggle'), onClick: function () { toggleAlarmEnabled(alarm); } }, alarm.enabled ? t('alarm.disable') : t('alarm.enable')),
        el('button', { className: 'dsn-btn danger', disabled: isBusy, title: t('alarm.delete'), onClick: function () { removeAlarm(alarm.id); } }, t('alarm.delete')),
      );

      var body = el(
        'div',
        { className: 'dsn-txt' },
        el('div', { className: 'dsn-title' }, alarm.label || t('alarm.untitled')),
        isImage
          ? null
          : el('div', { className: 'dsn-prev' }, (alarm.text || '').split('\n')[0].slice(0, 80)),
        el(
          'div',
          { className: 'dsn-foot-row' },
          el(
            'div',
            { className: 'dsn-meta' },
            el('span', { className: 'dsn-tag' }, alarm.scheduleText || ''),
            alarm.enabled ? null : el('span', { className: 'dsn-tag' }, t('alarm.off')),
            alarm.ringing ? el('span', { className: 'dsn-tag ringing' }, t('alarm.ringing')) : null,
            el('span', { className: 'dsn-time' }, nextText),
          ),
        ),
      );

      return el(
        'div',
        { key: alarm.id, className: alarm.ringing ? 'dsn-alarm-ringing' : null },
        el(
          'div',
          { className: 'dsn-row' },
          thumb,
          body,
          // A ringing alarm needs a way out from the list too, in case its popup is behind
          // something or on another display.
          alarm.ringing
            ? el('button', { className: 'dsn-btn', onClick: function () { dismissAlarm(alarm.id); } }, t('alarm.dismiss'))
            : null,
          actions,
        ),
      );
    });

    /** The alarm editor. Kept intentionally small: a label, content, and a schedule. */
    var alarmEditor = alarmDraft === null
      ? null
      : el(
          'div',
          { className: 'dsn-edit' },
          el(
            'label',
            { className: 'dsn-lab' },
            el('span', null, t('alarm.label')),
            el('input', {
              value: alarmDraft.label,
              placeholder: t('alarm.labelPlaceholder'),
              onChange: function (event) { patchAlarmDraft({ label: event.target.value }); },
            }),
          ),
          el(
            'div',
            { className: 'dsn-lab' },
            el('span', null, t('alarm.content')),
            el(
              'div',
              { className: 'dsn-seg' },
              el('button', {
                className: 'dsn-btn' + (alarmDraft.kind === 'text' ? ' primary' : ''),
                onClick: function () { patchAlarmDraft({ kind: 'text' }); },
              }, t('alarm.kindText')),
              el('button', {
                className: 'dsn-btn' + (alarmDraft.kind === 'image' ? ' primary' : ''),
                onClick: function () { patchAlarmDraft({ kind: 'image' }); },
              }, t('alarm.kindImage')),
            ),
          ),
          alarmDraft.kind === 'text'
            ? el('textarea', {
                value: alarmDraft.text,
                placeholder: t('alarm.textPlaceholder'),
                onChange: function (event) { patchAlarmDraft({ text: event.target.value }); },
              })
            : el(
                'div',
                { className: 'dsn-lab' },
                el('span', null, t('alarm.image')),
                el('span', { className: 'dsn-path', title: alarmDraft.image || '' }, alarmDraft.image || t('alarm.noImage')),
                el('button', { className: 'dsn-btn', disabled: busy === 'pick', onClick: pickAlarmImage }, t('alarm.chooseImage')),
              ),
          el(
            'div',
            { className: 'dsn-lab' },
            el('span', null, t('alarm.schedule')),
            el(
              'div',
              { className: 'dsn-seg' },
              el('button', {
                className: 'dsn-btn' + (alarmDraft.schedule.kind === 'daily' ? ' primary' : ''),
                onClick: function () { patchAlarmSchedule({ kind: 'daily' }); },
              }, t('alarm.daily')),
              el('button', {
                className: 'dsn-btn' + (alarmDraft.schedule.kind === 'weekdays' ? ' primary' : ''),
                onClick: function () { patchAlarmSchedule({ kind: 'weekdays' }); },
              }, t('alarm.weekdays')),
              el('button', {
                className: 'dsn-btn' + (alarmDraft.schedule.kind === 'once' ? ' primary' : ''),
                onClick: function () { patchAlarmSchedule({ kind: 'once' }); },
              }, t('alarm.once')),
            ),
          ),
          alarmDraft.schedule.kind === 'once'
            ? el('input', {
                type: 'datetime-local',
                value: alarmDraft.schedule.at,
                onChange: function (event) { patchAlarmSchedule({ at: event.target.value }); },
              })
            : el('input', {
                type: 'time',
                value: alarmDraft.schedule.time,
                onChange: function (event) { patchAlarmSchedule({ time: event.target.value }); },
              }),
          el(
            'div',
            { className: 'dsn-hintline' },
            alarmDraft.schedule.kind === 'once' ? t('alarm.onceHint') : t('alarm.repeatHint'),
          ),
          // The position control: 试响 is how you choose where it appears, so this says so
          // rather than leaving the user to discover it. Shown for a brand-new alarm too —
          // placing it is most useful before the first save.
          el(
            'div',
            { className: 'dsn-poshint' },
            el('span', { className: 'dsn-poshint-text' }, t('alarm.positionHint')),
            alarmDraft.x === null
              ? el('span', { className: 'dsn-poshint-where' }, t('alarm.positionDefault'))
              : el(
                  'span',
                  { className: 'dsn-poshint-where' },
                  t('alarm.positionSet') + ' ' + alarmDraft.x + ', ' + alarmDraft.y,
                  el(
                    'button',
                    { className: 'dsn-btn', onClick: clearAlarmPosition },
                    t('alarm.positionReset'),
                  ),
                ),
          ),
          el(
            'div',
            { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            el('button', { className: 'dsn-btn primary', disabled: busy === 'alarm', onClick: saveAlarm }, t('alarm.save')),
            // 试响 is offered here as well as on each row: this is where the user is looking
            // when they want to see and place the popup.
            el('button', { className: 'dsn-btn', disabled: busy === 'ring', onClick: testRing }, t('alarm.testRing')),
            el('button', { className: 'dsn-btn', onClick: function () { setAlarmDraft(null); } }, t('panel.cancel')),
          ),
        );

    // A hotkey conflict means the shortcut does nothing at all, so it is reported
    // here as well as in the settings page: the panel is where a user looks when
    // the key "does not work".
    var hotkeyConflict = helper && helper.running && helper.warning === 'conflict';

    var helperLine = helper && helper.running
      ? el(
          'div',
          { className: 'dsn-foot' },
          el('span', { className: 'dsn-dot', style: { background: hotkeyConflict ? '#f85149' : '#3fb950' } }),
          el('span', null, hotkeyConflict ? t('panel.hotkeyConflict') : t('panel.helperUp')),
          !hotkeyConflict && NS.hotkeyText(helper.hotkey)
            ? el('span', null, t('panel.hotkey') + '：' + NS.prettyHotkey(helper.hotkey))
            : null,
          hotkeyConflict
            ? el(
                'span',
                { style: { opacity: 0.8 } },
                NS.hotkeyText(helper.requestedHotkey) ? NS.prettyHotkey(helper.requestedHotkey) : '',
              )
            : null,
        )
      : el(
          'div',
          { className: 'dsn-foot' },
          el('span', { className: 'dsn-dot', style: { background: '#d29922' } }),
          el('span', null, t('panel.helperDown')),
        );

    var alarmCount = (state.alarms || []).length;
    var onNotes = tab === 'notes';

    // One sidebar entry, two lists: the tabs switch between them rather than adding a second
    // sidebar entry, which the sidebar contract does not allow.
    var tabs = el(
      'div',
      { className: 'dsn-tabs' },
      el(
        'button',
        { className: 'dsn-tab' + (onNotes ? ' on' : ''), onClick: function () { setTab('notes'); } },
        t('panel.tabNotes'),
        el('span', { className: 'dsn-count' }, ' · ' + state.notes.length),
      ),
      el(
        'button',
        { className: 'dsn-tab' + (onNotes ? '' : ' on'), onClick: function () { setTab('alarms'); } },
        t('panel.tabAlarms'),
        el('span', { className: 'dsn-count' }, ' · ' + alarmCount),
      ),
    );

    var head = onNotes
      ? el(
          'div',
          { className: 'dsn-head' },
          el('button', { className: 'dsn-btn', disabled: busy === 'shot', onClick: takeShot }, t('panel.screenshot')),
          el('button', { className: 'dsn-btn primary', disabled: busy === 'create', onClick: createNote }, t('panel.newNote')),
          el('button', { className: 'dsn-btn', onClick: function () { refresh(); } }, t('panel.refresh')),
        )
      : el(
          'div',
          { className: 'dsn-head' },
          el('button', { className: 'dsn-btn primary', onClick: startNewAlarm }, t('alarm.new')),
          el('button', { className: 'dsn-btn', onClick: function () { refresh(); } }, t('panel.refresh')),
        );

    var listBody = onNotes
      ? state.loading && state.notes.length === 0
        ? el('div', { className: 'dsn-empty' }, t('state.loading'))
        : rows.length === 0
          ? el('div', { className: 'dsn-empty' }, t('panel.empty'))
          : rows
      : state.loading && alarmCount === 0
        ? el('div', { className: 'dsn-empty' }, t('state.loading'))
        : alarmRows.length === 0
          ? el('div', { className: 'dsn-empty' }, t('alarm.empty'))
          : alarmRows;

    return el(
      'div',
      { className: 'dsn-panel' },
      tabs,
      head,
      banner,
      alarmEditor,
      el('div', { className: 'dsn-body' }, listBody),
      helperLine,
    );
  }

  NS.PanelIcon = PanelIcon;
  NS.NotesPanel = NotesPanel;
  NS.panelStyles = panelStyles;
})();

// ==================== lib/ui/settings.js ====================
/**
 * dsh-sticky-notes — the "便签设置" page inside DSH's settings panel.
 *
 * Registered on the `settings.section` slot from `lib/client.js`, so it appears
 * as its own page in the settings list next to General / Models / Plugins.
 *
 * Bundle contract: plain script, concatenated. No imports.
 *
 * @module dsh-sticky-notes/client/settings
 */
(function () {
  'use strict';

  var NS = (globalThis.__dshSticky = globalThis.__dshSticky || {});
  var h = null;

  /** Called once by the bundle entry, after React is required. */
  NS.initSettings = function initSettings(React) {
    h = React.createElement;
  };

  function el() {
    return h.apply(null, arguments);
  }

  var style = [
    '.dsn-set{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,inherit);font-size:13px}',
    '.dsn-set-card{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));border-radius:12px;padding:14px 16px;background:var(--dsw-alias-bg-layer-1,transparent);display:flex;flex-direction:column;gap:12px}',
    '.dsn-set-card h3{margin:0;font-size:14px;font-weight:600}',
    '.dsn-set-card h4{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,inherit)}',
    '.dsn-set-row{display:flex;justify-content:space-between;gap:16px;align-items:center}',
    '.dsn-set-row .dsn-set-label{display:flex;flex-direction:column;gap:2px;min-width:0}',
    '.dsn-set-hint{font-size:11px;color:var(--dsw-alias-label-secondary,inherit);line-height:1.6}',
    '.dsn-set-field{display:flex;align-items:center;gap:8px;flex:0 0 auto}',
    '.dsn-set input[type=text],.dsn-set input[type=number],.dsn-set select,.dsn-set input[type=color]{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;border-radius:8px;padding:6px 10px;font:inherit;font-size:13px}',
    '.dsn-set input[type=color]{padding:2px;width:44px;height:32px;cursor:pointer}',
    '.dsn-set input[type=range]{width:180px;accent-color:var(--dsw-alias-brand-primary,#2f6fed)}',
    '.dsn-set-btn{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:inherit;border-radius:8px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer;line-height:1.6}',
    '.dsn-set-btn:hover{background:color-mix(in srgb, currentColor 10%, transparent)}',
    '.dsn-set-btn.primary{background:var(--dsw-alias-brand-primary,#2f6fed);border-color:transparent;color:#fff}',
    '.dsn-set-btn.primary:hover{filter:brightness(1.08)}',
    '.dsn-set-btn[disabled]{opacity:.5;cursor:default}',
    '.dsn-set-btn.recording{border-color:var(--dsw-alias-brand-primary,#2f6fed);color:var(--dsw-alias-brand-primary,#2f6fed)}',
    // The service status row: a dot the eye finds before reading anything.
    '.dsn-svc{display:flex;align-items:center;gap:7px;font-weight:600}',
    '.dsn-svc-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 0 3px color-mix(in srgb, currentColor 12%, transparent)}',
    '.dsn-svc-detail{margin-top:5px;font-size:11px;opacity:.72;line-height:1.7;word-break:break-all}',
    '.dsn-svc-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}',
    // The plugin identity line: quiet, but on its own row so it never depends on helper state.
    '.dsn-set-about{display:flex;align-items:baseline;gap:8px;font-size:11px;opacity:.62;padding:0 2px}',
    '.dsn-set-about-name{font-variant-numeric:tabular-nums}',
    '.dsn-set-about-version{font-weight:600;font-variant-numeric:tabular-nums;padding:1px 6px;border-radius:999px;background:color-mix(in srgb, currentColor 12%, transparent)}',
    '.dsn-set-about-unknown{opacity:.75}',
    // The status-card chip, for when the helper state is the thing being read.
    '.dsn-svc-version{margin-left:auto;font-size:11px;font-weight:600;opacity:.75;font-variant-numeric:tabular-nums;padding:1px 7px;border-radius:999px;background:color-mix(in srgb, currentColor 14%, transparent)}',
    '.dsn-set-swatches{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
    '.dsn-set-swatch{width:24px;height:24px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0;flex:none}',
    '.dsn-set-swatch[data-on="1"]{border-color:var(--dsw-alias-brand-primary,#2f6fed)}',
    '.dsn-set-banner{border-radius:10px;padding:10px 12px;font-size:12px;line-height:1.7;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25))}',
    '.dsn-set-banner.warn{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#d29922) 14%, transparent);border-color:var(--dsw-alias-state-warn-primary,#d29922)}',
    '.dsn-set-banner.err{background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#f85149) 14%, transparent);border-color:var(--dsw-alias-state-error-primary,#f85149)}',
    '.dsn-set-banner.ok{background:color-mix(in srgb, var(--dsw-alias-state-success-primary,#3fb950) 14%, transparent);border-color:var(--dsw-alias-state-success-primary,#3fb950)}',
    '.dsn-preview{margin-top:2px;border-radius:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));box-shadow:0 4px 14px rgba(0,0,0,.14);min-height:56px;line-height:1.6}',
    '.dsn-set-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
  ].join('');

  /**
   * Translate a DOM keyboard event into an Electron accelerator.
   *
   * Electron's grammar needs at least one modifier plus a key, and its key names
   * differ from `KeyboardEvent.key` for a few punctuation and arrow keys, so a
   * naive `key` passthrough produces accelerators `globalShortcut` rejects.
   *
   * @param {KeyboardEvent} event
   * @returns {string|null} accelerator, or null when not usable
   */
  function acceleratorFromEvent(event) {
    var parts = [];
    if (event.ctrlKey) parts.push('CommandOrControl');
    if (event.metaKey && !event.ctrlKey) parts.push('Command');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');

    var key = String(event.key || '');
    var named = {
      ' ': 'Space',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      Escape: 'Escape',
      Enter: 'Return',
      Tab: 'Tab',
      Backspace: 'Backspace',
      Delete: 'Delete',
      '+': 'Plus',
    };

    if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return null;

    var name;
    if (named[key] !== undefined) name = named[key];
    else if (/^[a-zA-Z]$/.test(key)) name = key.toUpperCase();
    else if (/^[0-9]$/.test(key)) name = key;
    else if (/^F[0-9]{1,2}$/.test(key)) name = key;
    else if (key.length === 1) name = key.toUpperCase();
    else return null;

    // A bare key would swallow the whole keyboard system-wide.
    if (parts.length === 0) return null;
    return parts.concat([name]).join('+');
  }

  /**
   * Human-readable form for the UI, e.g. `Ctrl + Alt + S`.
   *
   * Delegates to the shared helper so the panel footer and this page can never
   * show the same accelerator two different ways.
   */
  function prettyAccelerator(accelerator) {
    return NS.prettyHotkey(accelerator);
  }

  /**
   * The settings page body.
   * @param {object} props slot props from DSH
   */
  function StickySettingsSection(props) {
    var t = props && typeof props.t === 'function' ? props.t : function (key) { return key; };
    var React = NS.React;
    if (React === undefined) return null;

    var stateHook = React.useState({ settings: null, helper: null, about: null, error: null, loading: true });
    var state = stateHook[0];
    var setState = stateHook[1];

    var recordingHook = React.useState(false);
    var recording = recordingHook[0];
    var setRecording = recordingHook[1];

    var noticeHook = React.useState(null);
    var notice = noticeHook[0];
    var setNotice = noticeHook[1];

    /** Which service action is in flight, so its button can show it and all can be disabled. */
    var serviceBusyHook = React.useState(null);
    var serviceBusy = serviceBusyHook[0];
    var setServiceBusy = serviceBusyHook[1];

    var refresh = React.useCallback(function () {
      return NS.api('/settings').then(function (payload) {
        if (payload && payload.error) {
          setState(function (prev) {
            return Object.assign({}, prev, { error: payload.error, loading: false });
          });
          return;
        }
        setState({
          settings: payload.settings || null,
          helper: payload.helper || null,
          about: payload.about || null,
          error: null,
          loading: false,
        });
      });
    }, []);

    /**
     * The live service status.
     *
     * Fetched separately from `/settings` because it is a real round trip to the helper, not a
     * reading of the host's bookkeeping: only that can tell "running" apart from "running but not
     * answering", which is the state a restart exists for. Kept off the settings payload so
     * saving a colour does not pay for a probe.
     */
    var refreshHelper = React.useCallback(function () {
      return NS.api('/helper')
        .then(function (payload) {
          if (payload && payload.error) return;
          setState(function (prev) {
            return Object.assign({}, prev, { helper: payload });
          });
        })
        .catch(function () {
          /* a failed probe is reported by the banner, not as an error */
        });
    }, []);

    React.useEffect(
      function () {
        refresh();
      },
      [refresh],
    );

    // Polled while this page is open, so a helper that dies shows as stopped without a reload.
    // It stops with the page, so nothing is polled while the user is elsewhere.
    React.useEffect(
      function () {
        let alive = true;
        const timer = setInterval(function () {
          if (alive) refreshHelper();
        }, 4000);
        return function () {
          alive = false;
          clearInterval(timer);
        };
      },
      [refreshHelper],
    );

    /** Persist a patch and reflect the authoritative result. */
    var save = React.useCallback(
      function (patch) {
        return NS.api('/settings', { method: 'PATCH', body: patch }).then(function (payload) {
          if (payload && payload.error) {
            setNotice({ kind: 'err', text: payload.error });
            return;
          }
          setState(function (prev) {
            return Object.assign({}, prev, {
              settings: payload.settings || prev.settings,
              helper: payload.helper || prev.helper,
              about: payload.about || prev.about,
            });
          });
          var applied = payload.applied || {};
          // `applied` is the hotkey registration outcome (`{ ok, hotkey,
          // requested, registered, error, warning }`). Two outcomes matter here: the
          // key is ours, or another application owns it and the user has to choose
          // something else. Nothing is ever registered on the user's behalf.
          if (patch.hotkey !== undefined && applied.ok !== true) {
            setNotice({ kind: 'err', text: applied.error || t('settings.hotkeyFailed') });
          } else if (patch.hotkey !== undefined) {
            setNotice({ kind: 'ok', text: t('settings.hotkeySaved') });
          } else {
            setNotice({ kind: 'ok', text: t('settings.saved') });
          }
        });
      },
      [t],
    );

    /** Capture the next key combination as the hotkey. */
    var onKeyDown = React.useCallback(
      function (event) {
        if (!recording) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') {
          setRecording(false);
          return;
        }
        var accelerator = acceleratorFromEvent(event);
        if (accelerator === null) {
          setNotice({ kind: 'warn', text: t('settings.needModifier') });
          return;
        }
        setRecording(false);
        save({ hotkey: accelerator });
      },
      [recording, save, t],
    );

    // Bind while recording only, and in the capture phase so the shell's own
    // shortcuts cannot intercept the combination first.
    React.useEffect(
      function () {
        if (!recording) return undefined;
        window.addEventListener('keydown', onKeyDown, true);
        return function () {
          window.removeEventListener('keydown', onKeyDown, true);
        };
      },
      [recording, onKeyDown],
    );

    var settings = state.settings;
    var helper = state.helper;

    /**
     * The plugin version, or null when the host could not report it.
     *
     * `null` means "unknown" and renders as nothing at all — showing "v0.0.0" or an empty "v" would
     * be worse than showing no version, because a version display is only useful if it can be trusted.
     */
    var about = state.about;
    var version = about !== null && about !== undefined && typeof about.version === 'string' && about.version.length > 0
      ? about.version
      : null;

    /**
     * Run a service action and adopt the status it returns.
     *
     * The status comes back from the action itself rather than from a follow-up probe, so the
     * button cannot appear to have done nothing while a separate request catches up.
     */
    var serviceAction = function (path) {
      setServiceBusy(path);
      setNotice(null);
      NS.api(path, { method: 'POST' })
        .then(function (payload) {
          if (payload && payload.error) {
            setNotice({ kind: 'err', text: String(payload.error) });
            return;
          }
          if (payload && payload.running !== undefined) {
            setState(function (prev) {
              return Object.assign({}, prev, { helper: payload });
            });
          }
        })
        .catch(function (error) {
          setNotice({ kind: 'err', text: String(error && error.message ? error.message : error) });
        })
        .finally(function () {
          setServiceBusy(null);
          // Reconcile with the truth: `start` can report success while the helper immediately
          // dies, and only a fresh probe catches that.
          refreshHelper();
        });
    };

    var helperBanner = null;
    if (helper !== null && helper !== undefined) {
      var running = helper.running === true;
      var responsive = helper.responsive === true;
      // Old payloads (and the first paint, before the probe answers) have no `state`; derive it
      // rather than showing a blank status.
      var serviceState = helper.state ? String(helper.state) : running ? 'running' : 'stopped';

      var dotColour = serviceState === 'running' ? '#3fb950' : serviceState === 'unresponsive' ? '#d29922' : '#f85149';
      var stateLabel =
        serviceState === 'running'
          ? t('settings.serviceRunning')
          : serviceState === 'unresponsive'
            ? t('settings.serviceUnresponsive')
            : t('settings.serviceStopped');

      var detail = [];
      if (serviceState === 'running') {
        var liveHotkey = NS.hotkeyText(helper.hotkey);
        if (liveHotkey) detail.push(t('settings.activeHotkey') + '：' + prettyAccelerator(liveHotkey));
        if (Array.isArray(helper.displays) && helper.displays.length > 0) {
          detail.push(t('settings.displays') + '：' + helper.displays.length);
        }
      }
      if (helper.pid !== undefined && helper.pid !== null) detail.push('PID ' + String(helper.pid));
      if (helper.electronPath) detail.push(String(helper.electronPath));
      if (serviceState !== 'running' && helper.error) detail.push(String(helper.error));
      if (serviceState === 'unresponsive') detail.push(t('settings.unresponsiveHint'));

      helperBanner = el(
        'div',
        { className: 'dsn-set-banner ' + (serviceState === 'running' ? 'ok' : serviceState === 'unresponsive' ? 'warn' : 'err') },
        el(
          'div',
          { className: 'dsn-svc' },
          el('span', { className: 'dsn-svc-dot', style: { background: dotColour } }),
          el('span', { className: 'dsn-svc-state' }, t('settings.serviceLabel') + '：' + stateLabel),
          // The plugin's own version, on the same row as the status it belongs to. Deliberately a
          // separate element rather than part of the detail sentence below, which can be empty or
          // long — a version tucked into either would be easy to miss.
          version === null
            ? null
            : el('span', { className: 'dsn-svc-version', title: t('settings.versionTitle') }, 'v' + version),
        ),
        el(
          'div',
          { className: 'dsn-svc-detail' },
          detail.length === 0 ? t('settings.serviceNoDetail') : detail.join('　·　'),
        ),
        el(
          'div',
          { className: 'dsn-svc-actions' },
          // 启动 only makes sense when it is not up; 重启 covers the wedged case, so both are
          // offered rather than making the user stop first and then start.
          serviceState === 'running'
            ? null
            : el(
                'button',
                {
                  className: 'dsn-set-btn',
                  disabled: serviceBusy !== null,
                  onClick: function () { serviceAction('/helper/start'); },
                },
                serviceBusy === '/helper/start' ? t('settings.working') : t('settings.startHelper'),
              ),
          el(
            'button',
            {
              className: 'dsn-set-btn',
              disabled: serviceBusy !== null,
              onClick: function () { serviceAction('/helper/restart'); },
            },
            serviceBusy === '/helper/restart' ? t('settings.working') : t('settings.restartHelper'),
          ),
          serviceState === 'stopped'
            ? null
            : el(
                'button',
                {
                  className: 'dsn-set-btn',
                  disabled: serviceBusy !== null,
                  onClick: function () { serviceAction('/helper/stop'); },
                },
                serviceBusy === '/helper/stop' ? t('settings.working') : t('settings.stopHelper'),
              ),
          el(
            'button',
            { className: 'dsn-set-btn', disabled: serviceBusy !== null, onClick: function () { refreshHelper(); } },
            t('settings.refreshService'),
          ),
        ),
      );
    }

    // A configured hotkey that another application already owns is a hard failure
    // (nothing is registered on the user's behalf), and it must be impossible to
    // miss: the first user to hit it reported "I pressed it and nothing happened",
    // because the only explanation lived in this page. It is stated permanently and
    // *added* to the status banner rather than replacing it, so "helper is running"
    // is never hidden by the warning.
    if (helper !== null && helper !== undefined && helper.warning === 'conflict') {
      var conflictBanner = el(
        'div',
        { className: 'dsn-set-banner err' },
        el('div', null, helper.warningText ? String(helper.warningText) : t('settings.hotkeyConflict')),
        el(
          'div',
          { className: 'dsn-set-hint', style: { marginTop: 6 } },
          t('settings.hotkeyConflictHint'),
        ),
      );
      helperBanner =
        helperBanner === null
          ? conflictBanner
          : el('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, helperBanner, conflictBanner);
    }

    if (state.loading && settings === null) {
      return el('div', { className: 'dsn-set' }, el('div', { className: 'dsn-set-hint' }, t('state.loading')));
    }
    if (settings === null) {
      return el(
        'div',
        { className: 'dsn-set' },
        el('div', { className: 'dsn-set-banner err' }, state.error ? String(state.error) : t('state.failed')),
      );
    }

    var noticeNode = null;
    if (notice !== null) {
      noticeNode = el('div', { className: 'dsn-set-banner ' + notice.kind }, notice.text);
    }

    // ------------------------------------------------------------------ rows

    var hotkeyRow = el(
      'div',
      { className: 'dsn-set-row' },
      el(
        'div',
        { className: 'dsn-set-label' },
        el('div', null, t('settings.hotkey')),
        el('div', { className: 'dsn-set-hint' }, t('settings.hotkeyHint')),
      ),
      el(
        'div',
        { className: 'dsn-set-field' },
        el(
          'button',
          {
            className: 'dsn-set-btn' + (recording ? ' recording' : ''),
            onClick: function () {
              setRecording(!recording);
              setNotice(null);
            },
          },
          recording ? t('settings.recording') : prettyAccelerator(settings.hotkey) || t('settings.notSet'),
        ),
        el(
          'button',
          {
            className: 'dsn-set-btn',
            title: t('settings.reset'),
            onClick: function () {
              save({ hotkey: 'CommandOrControl+Alt+S' });
            },
          },
          t('settings.reset'),
        ),
      ),
    );

    var colorSwatches = el(
      'div',
      { className: 'dsn-set-swatches' },
      NS.PALETTE.map(function (color) {
        return el('button', {
          key: color,
          className: 'dsn-set-swatch',
          'data-on': settings.backgroundColor === color ? '1' : '0',
          style: { background: color },
          title: color,
          onClick: function () {
            save({ backgroundColor: color });
          },
        });
      }),
      el('input', {
        type: 'color',
        value: /^#[0-9a-fA-F]{6}$/.test(settings.backgroundColor) ? settings.backgroundColor : '#000000',
        title: t('settings.backgroundColor'),
        onChange: function (event) {
          save({ backgroundColor: event.target.value });
        },
      }),
    );

    var colorRow = el(
      'div',
      { className: 'dsn-set-row' },
      el(
        'div',
        { className: 'dsn-set-label' },
        el('div', null, t('settings.backgroundColor')),
        el('div', { className: 'dsn-set-hint' }, t('settings.backgroundColorHint')),
      ),
      colorSwatches,
    );

    var opacityRow = el(
      'div',
      { className: 'dsn-set-row' },
      el(
        'div',
        { className: 'dsn-set-label' },
        el('div', null, t('settings.opacity')),
        el('div', { className: 'dsn-set-hint' }, t('settings.opacityHint')),
      ),
      el(
        'div',
        { className: 'dsn-set-field' },
        el('input', {
          type: 'range',
          min: 0.2,
          max: 1,
          step: 0.05,
          value: settings.opacity,
          onChange: function (event) {
            save({ opacity: Number(event.target.value) });
          },
        }),
        el('span', { style: { minWidth: 34, textAlign: 'right' } }, Math.round(settings.opacity * 100) + '%'),
      ),
    );

    var preview = el(
      'div',
      {
        className: 'dsn-preview',
        style: {
          background: NS.withAlpha(settings.backgroundColor, settings.opacity),
          color: settings.textColor,
          fontSize: settings.fontSize + 'px',
        },
      },
      t('settings.previewText'),
    );

    var numberRow = function (key, label, hint, min, max, step, unit) {
      return el(
        'div',
        { className: 'dsn-set-row' },
        el(
          'div',
          { className: 'dsn-set-label' },
          el('div', null, label),
          el('div', { className: 'dsn-set-hint' }, hint),
        ),
        el(
          'div',
          { className: 'dsn-set-field' },
          el('input', {
            type: 'number',
            min: min,
            max: max,
            step: step,
            value: settings[key],
            style: { width: 84 },
            onChange: function (event) {
              var value = Number(event.target.value);
              if (Number.isFinite(value)) {
                var patch = {};
                patch[key] = value;
                save(patch);
              }
            },
          }),
          el('span', { className: 'dsn-set-hint' }, unit),
        ),
      );
    };

    return el(
      'div',
      { className: 'dsn-set' },
      helperBanner,
      noticeNode,

      // The plugin identity, on its own line rather than only inside the status card above: that card
      // changes colour and wording with the helper's state, and the version is the one fact that must
      // be readable no matter what the helper is doing.
      about === null || about === undefined
        ? null
        : el(
            'div',
            { className: 'dsn-set-about' },
            el('span', { className: 'dsn-set-about-name' }, String(about.name ?? '')),
            version === null
              ? el('span', { className: 'dsn-set-about-unknown' }, t('settings.versionUnknown'))
              : el('span', { className: 'dsn-set-about-version' }, 'v' + version),
          ),

      el(
        'div',
        { className: 'dsn-set-card' },
        el('h3', null, t('settings.hotkeyCard')),
        hotkeyRow,
      ),

      el(
        'div',
        { className: 'dsn-set-card' },
        el('h3', null, t('settings.appearanceCard')),
        colorRow,
        opacityRow,
        el(
          'div',
          { className: 'dsn-set-row' },
          el(
            'div',
            { className: 'dsn-set-label' },
            el('div', null, t('settings.textColor')),
            el('div', { className: 'dsn-set-hint' }, t('settings.textColorHint')),
          ),
          el('input', {
            type: 'color',
            value: /^#[0-9a-fA-F]{6}$/.test(settings.textColor) ? settings.textColor : '#f5f5f5',
            onChange: function (event) {
              save({ textColor: event.target.value });
            },
          }),
        ),
        numberRow('fontSize', t('settings.fontSize'), t('settings.fontSizeHint'), 8, 72, 1, 'px'),
        el('h4', null, t('settings.preview')),
        preview,
      ),

      el(
        'div',
        { className: 'dsn-set-card' },
        el('h3', null, t('settings.behaviorCard')),
        el(
          'div',
          { className: 'dsn-set-row' },
          el(
            'div',
            { className: 'dsn-set-label' },
            el('div', null, t('settings.hideMode')),
            el('div', { className: 'dsn-set-hint' }, t('settings.hideModeHint')),
          ),
          el(
            'select',
            {
              value: settings.hideMode === 'tab' ? 'tab' : 'offscreen',
              onChange: function (event) {
                save({ hideMode: event.target.value });
              },
            },
            el('option', { value: 'offscreen' }, t('settings.hideModeOffscreen')),
            el('option', { value: 'tab' }, t('settings.hideModeTab')),
          ),
        ),
        numberRow('snapDistance', t('settings.snapDistance'), t('settings.snapDistanceHint'), 0, 200, 1, 'px'),
        numberRow('autoHideDelayMs', t('settings.autoHideDelay'), t('settings.autoHideDelayHint'), 0, 60000, 100, 'ms'),
        numberRow('revealDelayMs', t('settings.revealDelay'), t('settings.revealDelayHint'), 0, 5000, 10, 'ms'),
        el(
          'div',
          { className: 'dsn-set-row' },
          el(
            'div',
            { className: 'dsn-set-label' },
            el('div', null, t('settings.autoStart')),
            el('div', { className: 'dsn-set-hint' }, t('settings.autoStartHint')),
          ),
          el('input', {
            type: 'checkbox',
            checked: settings.autoStartHelper === true,
            onChange: function (event) {
              save({ autoStartHelper: event.target.checked });
            },
          }),
        ),
      ),
    );
  }

  NS.StickySettingsSection = StickySettingsSection;
  NS.settingsStyles = style;
  NS.prettyAccelerator = prettyAccelerator;
  /** Exposed for `tools/test-client-load.mjs`. */
  NS.acceleratorFromEvent = acceleratorFromEvent;

  // `settings.tabThickness` is intentionally no longer rendered: the hidden tab's
  // thickness is a fixed 36px because Electron grows any window narrower than
  // ~32px back to its own minimum, so the value was not actually adjustable.
})();

// ==================== lib/client.js ====================
/**
 * dsh-sticky-notes — browser entry.
 *
 * Packaging contract (verified against the working `dsh-ssh-manager` and
 * `dsh-orb` plugins):
 *
 *   - The file is served as a single self-contained bundle, so it must not
 *     `import` sibling files. Only `react` is resolvable through the loader.
 *   - `window.__ModuleLoader__.load({ id, factory })`, where `id` is the package
 *     name.
 *   - `factory(require)` returns a module whose `apply(ctx)` / `inject` pair the
 *     shell calls. `inject` names client **services**, not packages.
 *
 * This file is an *input* to `tools/build-client.mjs`, which prepends
 * `lib/ui/core.js`, `lib/ui/panel.js` and `lib/ui/settings.js` and writes
 * `lib/client.bundle.js`. Editing the bundle directly is a mistake — edit here.
 *
 * Everything registered here goes through `ctx.effect`, so a reload or unload
 * releases exactly what this plugin added.
 *
 * @module dsh-sticky-notes/client
 */
(function () {
  'use strict';

  window.__ModuleLoader__.load({
    id: 'dsh-sticky-notes-desktop',
    factory: function factory(require) {
      var React = require('react');
      var NS = globalThis.__dshSticky;

      // Hand React to the concatenated modules and stamp the factory functions
      // that close over a fixed `h`. Nothing may render before this runs.
      NS.React = React;
      NS.initPanel(React);
      NS.initSettings(React);

      var LOCALE_NS = NS.LOCALE_NS;
      var PANEL_ID = NS.PANEL_ID;
      var SETTINGS_ID = NS.SETTINGS_ID;

      var ZH = {
        'panel.title': '便签',
        'panel.newNote': '新建便签',
        'panel.screenshot': '截图',
        'panel.refresh': '刷新',
        'panel.open': '打开',
        'panel.edit': '编辑',
        'panel.delete': '删除',
        'panel.save': '保存',
        'panel.cancel': '取消',
        'panel.hide': '隐藏',
        'panel.show': '显示',
        'panel.empty': '还没有便签。点「新建便签」创建一个，或按快捷键唤出菜单。',
        'panel.untitled': '（无标题）',
        'panel.kindText': '文本',
        'panel.kindShot': '截图',
        'panel.hiddenTag': '已隐藏',
        'panel.pinnedTag': '已保留',
        'panel.pin': '保留',
        'panel.unpin': '取消保留',
        'panel.titlePlaceholder': '标题',
        'panel.textPlaceholder': '写点什么…',
        'panel.helperUp': '悬浮窗口助手运行中',
        'panel.helperDown': '悬浮窗口助手未运行，暂时无法弹出置顶便签（列表与编辑仍可用）。',
        'panel.hotkey': '快捷键',
        'panel.tabNotes': '便签',
        'panel.tabAlarms': '便签闹钟',

        'alarm.new': '新建闹钟',
        'alarm.empty': '还没有便签闹钟。点「新建闹钟」设一个：到时间会自动弹出置顶提醒。',
        'alarm.untitled': '（未命名闹钟）',
        'alarm.label': '名称',
        'alarm.labelPlaceholder': '例如：喝水、站会、交日报',
        'alarm.content': '显示内容',
        'alarm.kindText': '文字',
        'alarm.kindImage': '图片',
        'alarm.textPlaceholder': '到时间弹出来显示的文字',
        'alarm.image': '图片',
        'alarm.noImage': '（还没选图片）',
        'alarm.chooseImage': '选择图片…',
        'alarm.schedule': '什么时候',
        'alarm.daily': '每天',
        'alarm.weekdays': '工作日',
        'alarm.once': '指定时间',
        'alarm.onceHint': '只在指定的那一刻响一次；若那时 DSH 没运行，下次启动时会补响。',
        'alarm.repeatHint': '到点自动弹出置顶窗口；点「关闭」结束本次提醒。',
        'alarm.save': '保存闹钟',
        'alarm.edit': '编辑',
        'alarm.delete': '删除',
        'alarm.enable': '启用',
        'alarm.disable': '停用',
        'alarm.toggle': '启用 / 停用',
        'alarm.ringNow': '试响',
        'alarm.positionHint': '想让它弹在别的地方？点「试响」，把弹出的窗口拖到你要的位置，位置会被记住。',
        'alarm.positionDefault': '位置：默认（屏幕正中央）',
        'alarm.positionSet': '位置：',
        'alarm.positionReset': '恢复默认位置',
        'alarm.testRing': '试响',
        'alarm.dismiss': '关闭响铃',
        'alarm.off': '已停用',
        'alarm.ringing': '正在响',

        'settings.nav': '便签设置',
        'settings.versionUnknown': '版本未知',
        'settings.versionTitle': '当前安装的便签插件版本',
        'settings.serviceLabel': '便签服务',
        'settings.serviceRunning': '正在运行',
        'settings.serviceStopped': '未运行',
        'settings.serviceUnresponsive': '无响应',
        'settings.serviceNoDetail': '（没有更多信息）',
        'settings.unresponsiveHint': '进程还在但不响应了，点「重启服务」即可恢复。',
        'settings.restartHelper': '重启服务',
        'settings.stopHelper': '停止服务',
        'settings.refreshService': '刷新状态',
        'settings.working': '处理中…',
        'settings.displays': '显示器',
        'settings.hotkeyCard': '快捷键',
        'settings.hotkey': '唤出菜单',
        'settings.hotkeyHint': '按下后记录新的组合键。至少包含一个修饰键（Ctrl / Alt / Shift）。',
        'settings.recording': '请按下组合键…',
        'settings.notSet': '未设置',
        'settings.reset': '恢复默认',
        'settings.needModifier': '组合键必须至少包含 Ctrl、Alt 或 Shift 之一。',
        'settings.hotkeySaved': '快捷键已更新。',
        'settings.hotkeyFailed': '快捷键注册失败，可能已被其他程序占用。',
        'settings.saved': '已保存。',
        'settings.appearanceCard': '外观',
        'settings.backgroundColor': '背景颜色',
        'settings.backgroundColorHint': '新建便签的默认底色。',
        'settings.opacity': '不透明度',
        'settings.opacityHint': '数值越低越通透。',
        'settings.textColor': '文字颜色',
        'settings.textColorHint': '便签正文的颜色。',
        'settings.fontSize': '字号',
        'settings.fontSizeHint': '正文默认字号。',
        'settings.preview': '预览',
        'settings.previewText': '这是一条便签的预览效果。拖动、缩放、贴边都会自动保存。',
        'settings.behaviorCard': '行为',
        'settings.hideMode': '吸附隐藏方式',
        'settings.hideModeHint':
          '默认整块移出屏幕外，只在边缘留 1 像素，鼠标碰到屏幕边缘就滑回来；也可以改成收成一枚贴边的小标签。',
        'settings.hideModeOffscreen': '整块移出屏幕外（默认）',
        'settings.hideModeTab': '边缘小标签',
        'settings.snapDistance': '吸附距离',
        'settings.snapDistanceHint': '窗口距离屏幕边缘多少像素内自动吸附。',
        'settings.autoHideDelay': '自动隐藏延迟',
        'settings.autoHideDelayHint': '贴边后停多久自动隐藏。',
        'settings.revealDelay': '唤出延迟',
        'settings.revealDelayHint': '鼠标移到屏幕边缘后多久展开。',
        'settings.autoStart': '随 DSH 自动启动',
        'settings.autoStartHint': 'DSH 启动后自动拉起悬浮窗口助手并恢复所有便签。',
        'settings.helperUp': '便签服务运行中',
        'settings.helperDown': '便签服务未运行。置顶便签窗口需要独立的 Electron 运行时。',
        'settings.startHelper': '启动服务',
        'settings.electron': 'Electron',
        'settings.activeHotkey': '当前快捷键',
        'settings.hotkeyConflict': '快捷键被其他程序占用，按键不会生效。',
        'settings.hotkeyConflictHint':
          '请在「唤出菜单」里重新录制一个组合。Ctrl+Alt+S 会被 Windows「截图工具」等程序占用，可用 Ctrl+Shift+S、Ctrl+Alt+Shift+S 之类较冷门的组合。',
        'panel.hotkeyConflict': '快捷键冲突，按键无效（去「设置 → 便签设置」换一个）',

        'state.loading': '加载中…',
        'state.failed': '加载失败',
      };

      var EN = {
        'panel.title': 'Notes',
        'panel.newNote': 'New note',
        'panel.screenshot': 'Screenshot',
        'panel.refresh': 'Refresh',
        'panel.open': 'Open',
        'panel.edit': 'Edit',
        'panel.delete': 'Delete',
        'panel.save': 'Save',
        'panel.cancel': 'Cancel',
        'panel.hide': 'Hide',
        'panel.show': 'Show',
        'panel.empty': 'No notes yet. Use “New note”, or press the hotkey to open the menu.',
        'panel.untitled': '(untitled)',
        'panel.kindText': 'Text',
        'panel.kindShot': 'Shot',
        'panel.hiddenTag': 'Hidden',
        'panel.pinnedTag': 'Kept',
        'panel.pin': 'Keep',
        'panel.unpin': 'Unkeep',
        'panel.titlePlaceholder': 'Title',
        'panel.textPlaceholder': 'Write something…',
        'panel.helperUp': 'Floating-window helper is running',
        'panel.helperDown': 'The floating-window helper is not running, so always-on-top notes cannot appear (the list and editor still work).',
        'panel.hotkey': 'Hotkey',
        'panel.tabNotes': 'Notes',
        'panel.tabAlarms': 'Note alarms',

        'alarm.new': 'New alarm',
        'alarm.empty': 'No note alarms yet. Use “New alarm” to add one — it pops up on top when the time comes.',
        'alarm.untitled': '(untitled alarm)',
        'alarm.label': 'Name',
        'alarm.labelPlaceholder': 'e.g. drink water, standup, daily report',
        'alarm.content': 'Content',
        'alarm.kindText': 'Text',
        'alarm.kindImage': 'Image',
        'alarm.textPlaceholder': 'The text to show when it rings',
        'alarm.image': 'Image',
        'alarm.noImage': '(no image chosen yet)',
        'alarm.chooseImage': 'Choose image…',
        'alarm.schedule': 'When',
        'alarm.daily': 'Every day',
        'alarm.weekdays': 'Weekdays',
        'alarm.once': 'One time',
        'alarm.onceHint': 'Rings once at that moment. If DSH is not running then, it rings on the next start.',
        'alarm.repeatHint': 'Pops up always-on-top when the time comes; press 关闭 to end that reminder.',
        'alarm.save': 'Save alarm',
        'alarm.edit': 'Edit',
        'alarm.delete': 'Delete',
        'alarm.enable': 'Enable',
        'alarm.disable': 'Disable',
        'alarm.toggle': 'Enable / disable',
        'alarm.ringNow': 'Test',
        'alarm.positionHint': 'Want it somewhere else? Press 试响, drag the popup where you want it, and the position is remembered.',
        'alarm.positionDefault': 'Position: default (screen centre)',
        'alarm.positionSet': 'Position: ',
        'alarm.positionReset': 'Reset position',
        'alarm.testRing': 'Test',
        'alarm.dismiss': 'Stop ringing',
        'alarm.off': 'Disabled',
        'alarm.ringing': 'Ringing',

        'settings.nav': 'Sticky notes',
        'settings.versionUnknown': 'version unknown',
        'settings.versionTitle': 'The installed version of this sticky-notes plugin',
        'settings.serviceLabel': 'Note service',
        'settings.serviceRunning': 'Running',
        'settings.serviceStopped': 'Not running',
        'settings.serviceUnresponsive': 'Not responding',
        'settings.serviceNoDetail': '(no further detail)',
        'settings.unresponsiveHint': 'The process is alive but not answering. Use 重启服务 to recover.',
        'settings.restartHelper': 'Restart service',
        'settings.stopHelper': 'Stop service',
        'settings.refreshService': 'Refresh status',
        'settings.working': 'Working…',
        'settings.displays': 'Displays',
        'settings.hotkeyCard': 'Hotkey',
        'settings.hotkey': 'Open menu',
        'settings.hotkeyHint': 'Press a combination to record it. At least one modifier (Ctrl / Alt / Shift) is required.',
        'settings.recording': 'Press keys…',
        'settings.notSet': 'Not set',
        'settings.reset': 'Reset',
        'settings.needModifier': 'The combination needs at least one of Ctrl, Alt or Shift.',
        'settings.hotkeySaved': 'Hotkey updated.',
        'settings.hotkeyFailed': 'The hotkey could not be registered — another application may own it.',
        'settings.saved': 'Saved.',
        'settings.appearanceCard': 'Appearance',
        'settings.backgroundColor': 'Background',
        'settings.backgroundColorHint': 'Default background for new notes.',
        'settings.opacity': 'Opacity',
        'settings.opacityHint': 'Lower values are more translucent.',
        'settings.textColor': 'Text colour',
        'settings.textColorHint': 'Colour of the note body.',
        'settings.fontSize': 'Font size',
        'settings.fontSizeHint': 'Default body font size.',
        'settings.preview': 'Preview',
        'settings.previewText': 'A preview of a note. Dragging, resizing and edge snapping all save automatically.',
        'settings.behaviorCard': 'Behaviour',
        'settings.hideMode': 'How a snapped note hides',
        'settings.hideModeHint':
          'By default the note slides fully off the display leaving a 1px edge, and returns when the pointer reaches that edge. It can also collapse into a small tab at the edge.',
        'settings.hideModeOffscreen': 'Fully off-screen (default)',
        'settings.hideModeTab': 'Small edge tab',
        'settings.snapDistance': 'Snap distance',
        'settings.snapDistanceHint': 'How close to a screen edge a window snaps.',
        'settings.autoHideDelay': 'Auto-hide delay',
        'settings.autoHideDelayHint': 'How long a snapped note waits before hiding.',
        'settings.revealDelay': 'Reveal delay',
        'settings.revealDelayHint': 'How long the pointer must rest at the screen edge before the note returns.',
        'settings.autoStart': 'Start with DSH',
        'settings.autoStartHint': 'Launch the floating-window helper and restore every note when DSH starts.',
        'settings.helperUp': 'Floating-window helper is running',
        'settings.helperDown': 'The floating-window helper is not running. Always-on-top note windows need a separate Electron runtime.',
        'settings.startHelper': 'Start service',
        'settings.electron': 'Electron',
        'settings.activeHotkey': 'Active hotkey',
        'settings.hotkeyConflict': 'Another application owns this hotkey, so it does nothing.',
        'settings.hotkeyConflictHint':
          'Record a different combination under “Open menu”. On Windows, tools like Snipping Tool claim Ctrl+Alt+S; Ctrl+Shift+S or Ctrl+Alt+Shift+S are less contested.',
        'panel.hotkeyConflict': 'Hotkey conflict — the key does nothing (change it in Settings → Sticky notes)',

        'state.loading': 'Loading…',
        'state.failed': 'Failed to load',
      };

      /** Resolve a translation against the live locale, never a frozen dict. */
      function localize(ctx, key) {
        try {
          var locale = ctx.get('locale');
          if (locale === undefined) return ZH[key] !== undefined ? ZH[key] : key;
          var snapshot = typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null;
          var active = snapshot && typeof snapshot.active === 'string' ? snapshot.active : '';
          var dict = active.indexOf('en') === 0 ? EN : ZH;
          if (dict[key] !== undefined) return dict[key];
          var t = typeof locale.bind === 'function' ? locale.bind(LOCALE_NS) : null;
          if (typeof t === 'function') {
            var value = t(key);
            if (typeof value === 'string' && value !== key) return value;
          }
          return ZH[key] !== undefined ? ZH[key] : key;
        } catch (error) {
          return ZH[key] !== undefined ? ZH[key] : key;
        }
      }

      /** Inject our stylesheets once per run. */
      function injectStyles() {
        var style = NS.panelStyles + NS.settingsStyles;
        if (typeof document === 'undefined') return;
        var existing = document.getElementById('dsh-sticky-notes-style');
        if (existing !== null) {
          existing.textContent = style;
          return;
        }
        var node = document.createElement('style');
        node.id = 'dsh-sticky-notes-style';
        node.textContent = style;
        document.head.append(node);
      }

      var inject = ['slots', 'locale'];

      function apply(ctx) {
        try {
          injectStyles();
        } catch (error) {
          console.warn('sticky-notes: 样式注入失败：' + String(error));
        }

        try {
          ctx.effect(function () {
            return ctx.locale.register(LOCALE_NS, { zh: ZH, en: EN });
          }, 'sticky-notes: dictionaries');
        } catch (error) {
          console.warn('sticky-notes: 语言包注册失败：' + String(error));
        }

        // ------------------------------------------- 1. the full-page panel
        //
        // `main` is keyed by the sidebar entry id, so a fresh key is additive
        // rather than shadowing the shipped `conversation` panel.
        try {
          ctx.effect(
            function () {
              return ctx.slots.inject('main', function () {
                return ctx.slots.register({ name: 'main', key: PANEL_ID, locale: LOCALE_NS }, function (props) {
                  return React.createElement(NS.NotesPanel, props);
                });
              });
            },
            'sticky-notes: main panel',
          );
        } catch (error) {
          console.warn('sticky-notes: 主面板注册失败：' + String(error));
        }

        // --------------------------------- 2. the sidebar rail entry
        //
        // `sidebar.panellist` owns the button whose id addresses that panel —
        // this is the "便签列表入口" in the left column.
        try {
          ctx.effect(
            function () {
              return ctx.slots.inject('sidebar.panellist', function () {
                return ctx.slots.register(
                  {
                    name: 'sidebar.panellist',
                    id: PANEL_ID,
                    order: 30,
                    // Deliberately the short name. The bracketed package name belongs only to the
                    // plugin-list card, where several plugins sit side by side and it has to be
                    // clear which one this is; here the user is already inside this plugin.
                    label: function () {
                      return localize(ctx, NS.PLAIN_NAME_KEY);
                    },
                  },
                  NS.PanelIcon,
                );
              });
            },
            'sticky-notes: sidebar entry',
          );
        } catch (error) {
          console.warn('sticky-notes: 侧边栏入口注册失败：' + String(error));
        }

        // --------------------------------- 3. the settings page
        //
        // `settings.section` is a list whose owner renders one page per entry,
        // which is exactly the "设置界面里一个专门的便签设置" requirement.
        try {
          ctx.effect(
            function () {
              return ctx.slots.inject('settings.section', function () {
                return ctx.slots.register(
                  {
                    name: 'settings.section',
                    id: SETTINGS_ID,
                    order: 60,
                    // Short name, same reason as the sidebar entry.
                    label: function () {
                      return localize(ctx, NS.SETTINGS_NAME_KEY);
                    },
                    locale: LOCALE_NS,
                    inject: function () {
                      return {};
                    },
                  },
                  function (props) {
                    return React.createElement(NS.StickySettingsSection, props);
                  },
                );
              });
            },
            'sticky-notes: settings section',
          );
        } catch (error) {
          console.warn('sticky-notes: 设置页注册失败：' + String(error));
        }
      }

      return { apply: apply, inject: inject };
    },
  });
})();
