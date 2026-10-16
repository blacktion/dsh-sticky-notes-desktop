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

  /**
   * How long a delete button stays armed waiting for its second click.
   *
   * Matches the note window's own delete confirmation, so the two feel like the same control. It has
   * to be long enough to read the new label and click again, and short enough that an armed button
   * does not survive until some later, unrelated click.
   */
  var DELETE_CONFIRM_MS = 3000;

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
    // The armed state has to be unmistakable at a glance: it is the difference between "this will
    // delete" and "this has already been clicked once". Filled rather than outlined, so it reads as
    // the pressed/committed state instead of just a hovered one, and it keeps the hover background so
    // the pointer sitting on the button does not wash the distinction out.
    '.dsn-btn.danger.confirming{background:#f85149;border-color:#f85149;color:#fff;font-weight:600}',
    '.dsn-btn.danger.confirming:hover{background:#f85149;filter:brightness(1.08)}',
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

    /**
     * Which row's delete button is waiting for a second click.
     *
     * Deleting a note is the one irreversible action in the list — unlike a note window, the sidebar
     * offers no undo and the note's content is gone. So a single click only *arms* the button; the
     * delete runs on a second click within {@link DELETE_CONFIRM_MS}.
     *
     * This is the same two-step pattern the note window's own delete button uses, and it is
     * deliberately not a modal: a dialog would have to interrupt the whole panel, and this action is
     * small enough that a modal would be heavier than the mistake it prevents.
     */
    var deleteArmedHook = React.useState(null);
    var deleteArmed = deleteArmedHook[0];
    var setDeleteArmed = deleteArmedHook[1];
    /** Disarms the armed row; kept in a ref so the timeout survives re-renders. */
    var deleteTimerRef = React.useRef(null);

    /** Drop the armed state, whichever row holds it. Safe to call when nothing is armed. */
    var disarmDelete = React.useCallback(function () {
      if (deleteTimerRef.current !== null) {
        clearTimeout(deleteTimerRef.current);
        deleteTimerRef.current = null;
      }
      setDeleteArmed(null);
    }, []);

    // Never leave a timer running past unmount: the panel is torn down whenever the user switches
    // sidebar entries, and a live `setState` after that is a leak at best.
    React.useEffect(function () {
      return function () {
        if (deleteTimerRef.current !== null) clearTimeout(deleteTimerRef.current);
      };
    }, []);

    /**
     * The alarm list's own arming state, kept separate from the notes list's.
     *
     * Sharing one slot would mean arming a note silently disarmed an alarm (or the reverse), and the
     * two lists are visible one at a time — so a shared flag could be left armed on a list the user is
     * no longer looking at.
     */
    var alarmDeleteArmedHook = React.useState(null);
    var alarmDeleteArmed = alarmDeleteArmedHook[0];
    var setAlarmDeleteArmed = alarmDeleteArmedHook[1];
    var alarmDeleteTimerRef = React.useRef(null);

    React.useEffect(function () {
      return function () {
        if (alarmDeleteTimerRef.current !== null) clearTimeout(alarmDeleteTimerRef.current);
      };
    }, []);

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

    /**
     * Delete a note, but only on the second click.
     *
     * The first click arms the row and the button relabels itself 删除 → 确认删除, so the confirmation
     * is visible on the control the user is already pointing at rather than in a separate dialog. The
     * arming lapses after {@link DELETE_CONFIRM_MS}: an armed button left sitting there would turn a
     * click minutes later into an unintended delete, which is the exact failure this guards against.
     */
    var requestDelete = function (id) {
      if (deleteArmed !== id) {
        if (deleteTimerRef.current !== null) clearTimeout(deleteTimerRef.current);
        setDeleteArmed(id);
        deleteTimerRef.current = setTimeout(function () {
          deleteTimerRef.current = null;
          setDeleteArmed(null);
        }, DELETE_CONFIRM_MS);
        return;
      }
      disarmDelete();
      removeNote(id);
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

    /**
     * Delete an alarm, but only on the second click.
     *
     * Exactly the same gate as the notes list, and for the same reason: an alarm carries content the
     * user typed — a label, the text or image to show, and a schedule — none of which comes back after
     * a mis-click. Reusing the notes list's pattern rather than inventing a second one also means the
     * two lists behave identically, which is what a user will assume they do.
     *
     * The timer is separate from the notes list's: arming a note must not disarm an alarm.
     */
    var requestAlarmDelete = function (id) {
      if (alarmDeleteArmed !== id) {
        if (alarmDeleteTimerRef.current !== null) clearTimeout(alarmDeleteTimerRef.current);
        setAlarmDeleteArmed(id);
        alarmDeleteTimerRef.current = setTimeout(function () {
          alarmDeleteTimerRef.current = null;
          setAlarmDeleteArmed(null);
        }, DELETE_CONFIRM_MS);
        return;
      }
      disarmAlarmDelete();
      removeAlarm(id);
    };

    /** Drop the alarm list's armed state. Safe to call when nothing is armed. */
    var disarmAlarmDelete = function () {
      if (alarmDeleteTimerRef.current !== null) {
        clearTimeout(alarmDeleteTimerRef.current);
        alarmDeleteTimerRef.current = null;
      }
      setAlarmDeleteArmed(null);
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
      // The delete button carries its own confirmation state: the first click relabels it and only a
      // second click inside the window deletes. `armed` drives both the label and the styling, so the
      // button can never *look* ready to delete while behaving as the unarmed one.
      var armed = deleteArmed === note.id;
      var actions = el(
        'div',
        { className: 'dsn-acts' },
        el('button', { className: 'dsn-btn', disabled: isBusy, title: t('panel.open'), onClick: function () { openNote(note.id); } }, t('panel.open')),
        el('button', { className: 'dsn-btn', disabled: isBusy, title: t('panel.edit'), onClick: function () { (isEditing ? setEditing(null) : startEdit(note)); } }, isEditing ? t('panel.cancel') : t('panel.edit')),
        el('button', { className: 'dsn-btn', disabled: isBusy, title: note.pinned === true ? t('panel.unpin') : t('panel.pin'), onClick: function () { pinNote(note); } }, note.pinned === true ? t('panel.unpin') : t('panel.pin')),
        el(
          'button',
          {
            className: armed ? 'dsn-btn danger confirming' : 'dsn-btn danger',
            disabled: isBusy,
            title: armed ? t('panel.deleteConfirmHint') : t('panel.delete'),
            // Leaving the row drops the confirmation: an armed button that follows the pointer to
            // another note would delete the wrong one.
            onMouseLeave: armed ? disarmDelete : undefined,
            onClick: function () { requestDelete(note.id); },
          },
          armed ? t('panel.deleteConfirm') : t('panel.delete'),
        ),
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

      // Same two-step gate as the notes list: the first click arms the row and only a second click
      // inside the window deletes. `armed` drives both the label and the styling, so the button cannot
      // *look* ready to delete while behaving as the unarmed one.
      var armed = alarmDeleteArmed === alarm.id;
      var actions = el(
        'div',
        { className: 'dsn-acts' },
        el('button', { className: 'dsn-btn', disabled: isBusy, title: t('alarm.ringNow'), onClick: function () { ringAlarm(alarm.id); } }, t('alarm.ringNow')),
        el('button', { className: 'dsn-btn', disabled: isBusy, title: t('alarm.edit'), onClick: function () { startEditAlarm(alarm); } }, t('alarm.edit')),
        el('button', { className: 'dsn-btn', disabled: isBusy, title: t('alarm.toggle'), onClick: function () { toggleAlarmEnabled(alarm); } }, alarm.enabled ? t('alarm.disable') : t('alarm.enable')),
        el(
          'button',
          {
            className: armed ? 'dsn-btn danger confirming' : 'dsn-btn danger',
            disabled: isBusy,
            title: armed ? t('alarm.deleteConfirmHint') : t('alarm.delete'),
            // Leaving the row drops the confirmation, so an armed button cannot be carried to a
            // different alarm and delete that one instead.
            onMouseLeave: armed ? disarmAlarmDelete : undefined,
            onClick: function () { requestAlarmDelete(alarm.id); },
          },
          armed ? t('alarm.deleteConfirm') : t('alarm.delete'),
        ),
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
