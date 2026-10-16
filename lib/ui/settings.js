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
    // The update hint. `newer` is the only one that should catch the eye; the other two are quiet.
    '.dsn-set-about-newer{font-weight:600;color:#d29922;cursor:pointer;text-decoration:underline;text-underline-offset:2px}',
    '.dsn-set-about-newer:hover{filter:brightness(1.15)}',
    '.dsn-set-about-current{opacity:.6;cursor:pointer}',
    '.dsn-set-about-current:hover{opacity:.85}',
    '.dsn-set-about-checking{opacity:.6}',
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

    var stateHook = React.useState({ settings: null, helper: null, about: null, latest: null, error: null, loading: true });
    var state = stateHook[0];
    var setState = stateHook[1];

    var recordingHook = React.useState(false);
    var recording = recordingHook[0];
    var setRecording = recordingHook[1];

    /** True while the user has asked for a fresh version check, so the effect re-runs. */
    var checkingLatestHook = React.useState(false);
    var checkingLatest = checkingLatestHook[0];
    var setCheckingLatest = checkingLatestHook[1];

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
        setState(function (prev) {
          return {
            settings: payload.settings || null,
            helper: payload.helper || null,
            about: payload.about || null,
            // Kept across the settings refresh: the update hint is about the package, not about this
            // payload, and re-asking the registry every 4 seconds would be rude to npm.
            latest: prev.latest,
            error: null,
            loading: false,
          };
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

    /**
     * Ask the host what the latest published release is, and show the answer next to the version.
     *
     * Separate from `refresh` because this one is slow and may fail: it is a network round trip on the
     * host side. Firing it alongside the settings load means the page renders immediately and the hint
     * appears a moment later, instead of the whole page waiting on the registry — or failing to render
     * on a machine with no outbound access.
     *
     * The answer is cached by the host for half an hour, so switching away from this page and back does
     * not re-ask. `checkingLatest` re-runs this effect only when the user asks for a fresh check.
     */
    React.useEffect(
      function () {
        let alive = true;
        NS.api('/version-check' + (checkingLatest === true ? '?force=1' : '')).then(function (payload) {
          if (!alive) return;
          setState(function (prev) {
            return Object.assign({}, prev, { latest: payload && payload.ok === true ? payload : null });
          });
          setCheckingLatest(false);
        });
        return function () {
          alive = false;
        };
      },
      [checkingLatest],
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
     * What the registry reported about the latest release.
     *
     * `null` means "nothing to say": either the answer has not arrived, or the check failed, or this copy
     * was not installed from the registry at all. All three render as nothing, because an update hint is
     * a convenience — showing an error for it would put noise on a settings page belonging to someone who
     * is merely offline.
     */
    var latest = state.latest;
    var latestNote = null;
    if (latest !== null && latest !== undefined) {
      if (latest.ok === true && typeof latest.latest === 'string') {
        if (latest.updateAvailable === true) {
          latestNote = el(
            'span',
            {
              className: 'dsn-set-about-newer',
              title: t('settings.updateAvailableHint'),
              onClick: function () {
                setCheckingLatest(true);
              },
            },
            t('settings.updateAvailable') + ' v' + latest.latest,
          );
        } else {
          latestNote = el(
            'span',
            {
              className: 'dsn-set-about-current',
              title: t('settings.checkAgainHint'),
              onClick: function () {
                setCheckingLatest(true);
              },
            },
            t('settings.upToDate'),
          );
        }
      } else if (checkingLatest === true) {
        // The check the user just asked for failed. Say so — they clicked something and are waiting for
        // an answer. A *background* failure stays silent: a machine that is simply offline should show
        // the version and nothing else.
        latestNote = el('span', { className: 'dsn-set-about-checking' }, t('settings.checkUpdateFailed'));
      }
    } else if (checkingLatest === true) {
      latestNote = el('span', { className: 'dsn-set-about-checking' }, t('settings.checkingUpdate'));
    }

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
            // What the registry says, when it answered. Before it does, and after any failure, this
            // renders nothing at all — an update hint is a convenience, and an error message about it
            // would be noise on a machine that is simply offline.
            latestNote,
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
