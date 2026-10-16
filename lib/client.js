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
        'panel.deleteConfirm': '确认删除',
        'panel.deleteConfirmHint': '再点一次即永久删除，无法撤销',
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
        'alarm.deleteConfirm': '确认删除',
        'alarm.deleteConfirmHint': '再点一次即永久删除这个闹钟，无法撤销',
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
        'settings.upToDate': '已是最新',
        'settings.updateAvailable': '有新版本',
        'settings.updateAvailableHint': 'npm 上已有新版本，点击重新检查',
        'settings.checkAgainHint': '已是最新版本，点击重新检查',
        'settings.checkingUpdate': '正在检查…',
        'settings.checkUpdateFailed': '检查失败，点击重试',
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
        'panel.deleteConfirm': 'Confirm delete',
        'panel.deleteConfirmHint': 'Click again to delete permanently — this cannot be undone',
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
        'alarm.deleteConfirm': 'Confirm delete',
        'alarm.deleteConfirmHint': 'Click again to delete this alarm permanently — this cannot be undone',
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
        'settings.upToDate': 'up to date',
        'settings.updateAvailable': 'update available',
        'settings.updateAvailableHint': 'A newer version is on npm — click to check again',
        'settings.checkAgainHint': 'Up to date — click to check again',
        'settings.checkingUpdate': 'checking…',
        'settings.checkUpdateFailed': 'check failed — click to retry',
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
