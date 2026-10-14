/**
 * dsh-sticky-notes-desktop — the tools the model calls, and the docs it reads.
 *
 * ## Why this file exists
 *
 * The first version registered ONE tool named `sticky_notes` with an `action` enum covering seven
 * operations. It never worked, and the reason matters more than the bug: the tool was registered
 * inside `ctx.inject(['tools'], (toolCtx) => toolCtx.tools.register(…))`, but an injected context
 * does not expose services as properties — `toolCtx.tools` is `undefined`, the `try` caught the
 * `TypeError`, and the plugin logged a warning nobody reads. The model therefore had **no tool at
 * all**, and every "make me a sticky note" had to be improvised out of `pwsh` and file reads. That
 * is what "slow and bad at it" actually was.
 *
 * So: services are declared through the `inject` export and reached as `ctx.tools`, which is the
 * convention DSH's own plugins follow, and registration is no longer wrapped in a `try` that can
 * swallow a programming error into a warning.
 *
 * ## Why one tool per operation
 *
 * A single tool with an `action` enum makes the model work out, from prose, which fields belong to
 * which action and what the enum values are. Eight small tools whose names say what they do remove
 * that inference step — `sticky_notes_create` cannot be confused with `sticky_notes_alarm_set`.
 * The descriptions are read once, from the tool list, instead of being reconstructed.
 *
 * @module dsh-sticky-notes-desktop/host/tools
 */

/** Cap on any string returned to the model, so one huge note cannot dominate the context. */
const MAX_TEXT = 20000;

/** A loose JSON object schema: DSH validates the *output* against this, so it must stay permissive. */
function looseObject(properties) {
  return { type: 'object', additionalProperties: true, properties };
}

/**
 * The output shape every tool here shares: a boolean plus model-facing text.
 *
 * `render` is what the model actually reads — `execute`'s structured value only feeds the UI and
 * the output snapshot. Putting the human-readable answer in `text` keeps the two in step, and
 * avoids the `tool "…" returned invalid output: value is not lossless JSON` failure that DSH raises
 * when a tool hands back something it cannot serialise.
 *
 * **`render` must return a `ContentBlock[]`, not a string.**
 *
 * The registry does not check the shape — `snapshotProjection` only requires lossless JSON — so a
 * string is accepted at registration and at projection time, and then breaks a consumer that calls
 * `.some(…)` on `result.content`. In this DSH version the exact thrower is
 * `@deepseek-ai/dsh-spill-policy`'s `tools/post-execute` listener: it is registered
 * `{ prepend: true }`, enabled by default through `dsh-base`, runs on **every** tool result, and
 * sits outside any `try` — so it throws *after* the tool body has already committed.
 *
 * The symptom is therefore `content.some is not a function` on every call while the action itself
 * succeeds, which reads as "the action worked and the reporting is broken". DSH does ship a
 * validator with a perfect message for this (`assertRenderedContent` in `dsh-cordis-host-runner`),
 * but it guards only the sandboxed `harness.defineTool` path — a plugin calling
 * `ctx.tools.register` directly never trips it, which is why the bug is silent.
 *
 * Every tool DSH ships returns `[{ type: 'text', text }]`; this now does the same.
 *
 * Exported so `tools/test-tool-registration.mjs` can pin the normalisation below instead of
 * trusting it.
 */
export function textOutput(extraProperties = {}, render) {
  return {
    schema: looseObject({ ok: { type: 'boolean' }, text: { type: 'string' }, ...extraProperties }),
    // A bare string is coerced to one text block rather than trusted, so a custom `render` cannot
    // reintroduce the bug by returning a string.
    render: (args, value) => {
      const produced = render === undefined ? String(value?.text ?? '') : render(args, value);
      // Already an array: pass through untouched. DSH supports multi-block results (text plus an
      // image), and coercing here would silently drop the extra blocks.
      if (Array.isArray(produced)) return produced;
      return [{ type: 'text', text: typeof produced === 'string' ? produced : String(produced ?? '') }];
    },
  };
}

/** Never let a huge body reach the context unbounded. */
function clip(value) {
  if (typeof value !== 'string') return '';
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}\n…（已截断，共 ${value.length} 字）` : value;
}

/** A one-line summary of a note, shared by every listing. */
function summarize(note) {
  const body = (note.text || note.title || '').replace(/\s+/g, ' ').trim();
  const what = note.kind === 'shot' ? '截图' : '文本';
  const where = note.hidden ? '已隐藏' : '显示中';
  const kept = note.pinned === true ? '｜已保留' : '';
  return `- ${note.id}｜${what}｜${where}${kept}｜${note.title ? `${note.title}｜` : ''}${body.slice(0, 60) || '(空)'}`;
}

/**
 * Build every tool definition.
 *
 * @param {object} deps
 * @param {import('./store.js').StickyStore} deps.store
 * @param {import('./bridge.js').StickyBridge} deps.bridge
 * @param {{ list: Function, preview: Function, previewDraft: Function }} [deps.alarms]
 * @returns {Array<object>}
 */
export function buildTools({ store, bridge, alarms }) {
  /** Wrap a handler so no tool ever rejects — a rejected execute is presented as an ugly crash. */
  const guard = (label, handler) => async (args, exec) => {
    try {
      return await handler(args ?? {}, exec);
    } catch (error) {
      return { ok: false, text: `${label}失败：${error instanceof Error ? error.message : String(error)}` };
    }
  };

  const tools = [
    // ------------------------------------------------------------------ list
    {
      name: 'sticky_notes_list',
      description:
        '列出桌面上的全部便签（含已隐藏的）。每行给出 id、类型（文本/截图）、是否隐藏、是否已保留，以及内容摘要。**要操作某条便签前先用它拿 id。**',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          include_hidden: {
            type: 'boolean',
            description: '是否包含已隐藏的便签，默认 true（隐藏只是贴边收起了，便签还在）。',
          },
        },
      },
      output: textOutput({ count: { type: 'number' } }),
      execute: guard('列出便签', async (args) => {
        const includeHidden = args.include_hidden !== false;
        const notes = store.listNotes().filter((note) => includeHidden || note.hidden !== true);
        if (notes.length === 0) {
          return { ok: true, count: 0, text: '当前没有便签。用 sticky_notes_create 新建一条。' };
        }
        return { ok: true, count: notes.length, text: `共 ${notes.length} 个便签：\n${notes.map(summarize).join('\n')}` };
      }),
    },

    // ---------------------------------------------------------------- create
    {
      name: 'sticky_notes_create',
      description:
        '在桌面上新建一条便签，并立刻以置顶悬浮窗口显示。这是"给我记一下/新建便签/贴个便签"应该直接调用的工具 —— 一次调用即可，不要用 pwsh 或文件操作去凑。颜色、透明度不传就用用户在设置里配的默认值。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '便签正文。支持多行（\\n）。' },
          title: { type: 'string', description: '标题，显示在正文上方。可省略。' },
          color: { type: 'string', description: '背景色 #rrggbb。省略则用设置里的默认色。' },
          opacity: { type: 'number', description: '不透明度 0.2–1。省略则用设置里的默认值。' },
          x: { type: 'number', description: '屏幕 x 坐标（左上角，像素）。省略则由窗口自行决定。' },
          y: { type: 'number', description: '屏幕 y 坐标。与 x 一起使用。' },
        },
        required: ['text'],
      },
      output: textOutput({ id: { type: 'string' }, shown: { type: 'boolean' } }),
      execute: guard('新建便签', async (args) => {
        const settings = store.getSettings();
        const patch = {
          kind: 'text',
          text: clip(typeof args.text === 'string' ? args.text : ''),
          title: typeof args.title === 'string' ? args.title : '',
          color: typeof args.color === 'string' && args.color.length > 0 ? args.color : settings.backgroundColor,
          opacity: typeof args.opacity === 'number' ? args.opacity : settings.opacity,
        };
        // A position only counts when both axes are real numbers: a half-specified point would
        // silently park the note at (0,0), which reads as a bug.
        if (typeof args.x === 'number' && typeof args.y === 'number') {
          patch.x = Math.round(args.x);
          patch.y = Math.round(args.y);
        }
        const note = store.upsertNote(patch);
        store.flush();
        const opened = await bridge.openNote(note.id);
        const shown = opened?.ok === true;
        return {
          ok: true,
          id: note.id,
          shown,
          text: shown
            ? `已新建便签 ${note.id}，并作为置顶窗口显示。`
            : `已新建便签 ${note.id}，但窗口没能显示（${opened?.error ?? '助手未运行'}）；便签本身已经保存，用户在左侧「便签」列表里能看到它。`,
        };
      }),
    },

    // ------------------------------------------------------------------ read
    {
      name: 'sticky_notes_read',
      description: '读取一条便签的完整正文、位置、颜色等字段。id 从 sticky_notes_list 获取。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', description: '便签 id。' } },
        required: ['id'],
      },
      output: textOutput({ note: looseObject({}) }),
      execute: guard('读取便签', async (args) => {
        const note = store.getNote(String(args.id ?? ''));
        if (note === null) return { ok: false, text: `找不到便签 ${String(args.id ?? '')}。先用 sticky_notes_list 看一下有哪些。` };
        const lines = [
          `便签 ${note.id}`,
          `类型：${note.kind === 'shot' ? '截图' : '文本'}`,
          `状态：${note.hidden ? '已隐藏（贴边收起）' : '显示中'}${note.pinned === true ? '，已保留（不自动隐藏）' : ''}`,
          `位置：x=${note.x} y=${note.y} 尺寸=${note.width}×${note.height}`,
          `外观：底色 ${note.color}，不透明度 ${note.opacity}，文字 ${note.textColor}`,
          note.image ? `图片：${note.image}` : null,
          note.title ? `标题：${note.title}` : null,
          '',
          clip(note.text) || '(无正文)',
        ].filter((line) => line !== null);
        return { ok: true, note, text: lines.join('\n') };
      }),
    },

    // ---------------------------------------------------------------- update
    {
      name: 'sticky_notes_update',
      description: '修改一条便签的正文、标题、颜色、不透明度或位置。只传要改的字段，其余保持不变。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '便签 id。' },
          text: { type: 'string', description: '新的正文。' },
          title: { type: 'string', description: '新的标题。' },
          color: { type: 'string', description: '新的背景色 #rrggbb。' },
          opacity: { type: 'number', description: '新的不透明度 0.2–1。' },
          x: { type: 'number', description: '新的屏幕 x 坐标。需与 y 同时给出。' },
          y: { type: 'number', description: '新的屏幕 y 坐标。' },
        },
        required: ['id'],
      },
      output: textOutput({ id: { type: 'string' } }),
      execute: guard('修改便签', async (args) => {
        const id = String(args.id ?? '');
        const patch = {};
        if (typeof args.text === 'string') patch.text = clip(args.text);
        if (typeof args.title === 'string') patch.title = args.title;
        if (typeof args.color === 'string' && args.color.length > 0) patch.color = args.color;
        if (typeof args.opacity === 'number') patch.opacity = args.opacity;
        if (typeof args.x === 'number' && typeof args.y === 'number') {
          patch.x = Math.round(args.x);
          patch.y = Math.round(args.y);
        }
        if (Object.keys(patch).length === 0) return { ok: false, text: '没有给出任何要修改的字段。' };
        const note = store.updateNote(id, patch);
        if (note === null) return { ok: false, text: `找不到便签 ${id}。` };
        store.flush();
        await bridge.pushNote(id, patch);
        return { ok: true, id, text: `已更新便签 ${id}（改了：${Object.keys(patch).join('、')}）。` };
      }),
    },

    // ---------------------------------------------------------------- delete
    {
      name: 'sticky_notes_delete',
      description: '删除一条便签，同时关闭它的窗口。不可撤销 —— 用户只是想让便签别再挡着时，优先考虑 sticky_notes_hide 而不是删除。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', description: '便签 id。' } },
        required: ['id'],
      },
      output: textOutput({ removed: { type: 'boolean' } }),
      execute: guard('删除便签', async (args) => {
        const id = String(args.id ?? '');
        await bridge.closeNote(id);
        const removed = store.deleteNote(id);
        store.flush();
        return { ok: removed, removed, text: removed ? `已删除便签 ${id}。` : `找不到便签 ${id}。` };
      }),
    },

    // ------------------------------------------------------------ show / hide
    {
      name: 'sticky_notes_show',
      description:
        '把一条便签的窗口显示到最前面（如果它被关掉或贴边隐藏了，就重新弹出）。用于"把那条便签给我看看"。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', description: '便签 id。' } },
        required: ['id'],
      },
      output: textOutput({ shown: { type: 'boolean' } }),
      execute: guard('显示便签', async (args) => {
        const id = String(args.id ?? '');
        const opened = await bridge.openNote(id);
        const shown = opened?.ok === true;
        return { ok: shown, shown, text: shown ? `已把便签 ${id} 显示到最前。` : `无法显示便签 ${id}：${opened?.error ?? '未知原因'}。` };
      }),
    },
    {
      name: 'sticky_notes_hide',
      description:
        '把一条便签收起来（贴到屏幕边缘隐藏），窗口还在、内容还在，之后可以 sticky_notes_show 唤回。想彻底移除用 sticky_notes_delete。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '便签 id。' },
          hidden: { type: 'boolean', description: 'true 收起（默认），false 展开。' },
        },
        required: ['id'],
      },
      output: textOutput({ hidden: { type: 'boolean' } }),
      execute: guard('隐藏便签', async (args) => {
        const id = String(args.id ?? '');
        const hidden = args.hidden !== false;
        const note = store.updateNote(id, { hidden });
        if (note === null) return { ok: false, text: `找不到便签 ${id}。` };
        store.flush();
        const result = await bridge.setHidden(id, hidden);
        return {
          ok: result?.ok !== false,
          hidden,
          text: hidden ? `已收起便签 ${id}（贴边隐藏，内容仍在）。` : `已展开便签 ${id}。`,
        };
      }),
    },

    // ---------------------------------------------------------------- alarms
    {
      name: 'sticky_notes_alarm_list',
      description:
        '列出全部「便签闹钟」：名称、排期（每天/工作日/指定时间）、下次响的时间、是否启用、是否正在响。要改某条闹钟前先用它拿 id。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: textOutput({ count: { type: 'number' } }),
      execute: guard('列出闹钟', async () => {
        if (!alarms) return { ok: false, text: '闹钟服务不可用。' };
        const list = alarms.list();
        if (list.length === 0) return { ok: true, count: 0, text: '当前没有便签闹钟。用 sticky_notes_alarm_set 新建一条。' };
        const lines = list.map((alarm) => {
          const bits = [
            `- ${alarm.id}`,
            alarm.label || '(未命名)',
            alarm.scheduleText,
            alarm.enabled === false ? '已停用' : alarm.nextAt ? `下次 ${String(alarm.nextAt).replace('T', ' ').slice(0, 16)}` : '无下次',
            alarm.ringing ? '**正在响**' : null,
          ].filter((bit) => bit !== null);
          return bits.join('｜');
        });
        return { ok: true, count: list.length, text: `共 ${list.length} 条闹钟：\n${lines.join('\n')}` };
      }),
    },
    {
      name: 'sticky_notes_alarm_set',
      description:
        '新建或修改一条「便签闹钟」：到时间自动弹出一个置顶窗口，内容是文字或图片。schedule 三选一：每天(daily)、工作日(weekdays)、指定时间一次(once)。这条工具同时用于新建和修改 —— 给了 id 就是改那条。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '要修改的闹钟 id。省略则新建一条。' },
          label: { type: 'string', description: '闹钟名称，例如"喝水""站会""交日报"。' },
          text: { type: 'string', description: '弹窗显示的正文（kind=text 时）。' },
          kind: { type: 'string', enum: ['text', 'image'], description: '弹窗内容类型，默认 text。' },
          image: { type: 'string', description: '图片绝对路径（kind=image 时）。一般应由用户在界面里选择。' },
          schedule: {
            type: 'object',
            additionalProperties: false,
            description:
              '排期。kind 三选一：daily 每天、weekdays 工作日、once 指定时刻一次。daily/weekdays 填 time，once 填 at。',
            properties: {
              kind: { type: 'string', enum: ['daily', 'weekdays', 'once'], description: '排期类型。' },
              time: { type: 'string', description: `每天/工作日的时间，24 小时制 HH:MM，例如 "09:30"（kind=daily/weekdays 时必填）。` },
              at: {
                type: 'string',
                description: `指定时间的本地时刻，格式 "YYYY-MM-DDTHH:MM"，例如 "2026-03-05T09:30"（kind=once 时必填）。只响一次。`,
              },
            },
            required: ['kind'],
          },
          enabled: { type: 'boolean', description: '是否启用，默认 true。' },
        },
      },
      output: textOutput({ id: { type: 'string' } }),
      execute: guard('设置闹钟', async (args) => {
        if (!alarms) return { ok: false, text: '闹钟服务不可用。' };
        const schedule = args.schedule !== null && typeof args.schedule === 'object' ? args.schedule : null;
        if (schedule === null) return { ok: false, text: '必须给出 schedule。' };

        const kind = schedule.kind;
        if (kind === 'daily' || kind === 'weekdays') {
          if (typeof schedule.time !== 'string' || !/^\d{1,2}:\d{2}$/.test(schedule.time)) {
            return { ok: false, text: `schedule.time 必须是 "HH:MM"，例如 "09:30"（收到 ${JSON.stringify(schedule.time)}）。` };
          }
        } else if (kind === 'once') {
          if (typeof schedule.at !== 'string' || schedule.at.length === 0) {
            return { ok: false, text: 'kind=once 时必须给出 schedule.at，格式 "YYYY-MM-DDTHH:MM"。' };
          }
        } else {
          return { ok: false, text: `schedule.kind 必须是 daily / weekdays / once（收到 ${JSON.stringify(kind)}）。` };
        }

        const patch = {
          label: typeof args.label === 'string' ? args.label : '',
          kind: args.kind === 'image' ? 'image' : 'text',
          text: typeof args.text === 'string' ? args.text : '',
          image: typeof args.image === 'string' && args.image.length > 0 ? args.image : null,
          schedule: { kind, time: typeof schedule.time === 'string' ? schedule.time : '09:00', at: typeof schedule.at === 'string' ? schedule.at : '' },
          enabled: args.enabled !== false,
        };
        if (typeof args.id === 'string' && args.id.length > 0) patch.id = args.id;

        const alarm = store.upsertAlarm(patch);
        store.flush();
        const listed = alarms.list().find((entry) => entry.id === alarm.id);
        const when = listed?.nextAt ? `，下次响：${String(listed.nextAt).replace('T', ' ').slice(0, 16)}` : '';
        return {
          ok: true,
          id: alarm.id,
          text: `${typeof args.id === 'string' && args.id.length > 0 ? '已更新' : '已新建'}闹钟「${alarm.label || alarm.id}」（${listed?.scheduleText ?? kind}）${when}。到时间会自动弹出置顶窗口，用户点关闭即可。`,
        };
      }),
    },
    {
      name: 'sticky_notes_alarm_delete',
      description: '删除一条便签闹钟，同时收掉它正在显示的弹窗。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', description: '闹钟 id。' } },
        required: ['id'],
      },
      output: textOutput({ removed: { type: 'boolean' } }),
      execute: guard('删除闹钟', async (args) => {
        const id = String(args.id ?? '');
        await bridge.closeAlarm(id).catch(() => {});
        const removed = store.deleteAlarm(id);
        store.flush();
        return { ok: removed, removed, text: removed ? `已删除闹钟 ${id}。` : `找不到闹钟 ${id}。` };
      }),
    },
    {
      name: 'sticky_notes_alarm_ring',
      description:
        '立刻试响一条闹钟，用来预览它长什么样、或让用户调位置（用户可以把弹窗拖到想要的位置，位置会被记住）。不会消耗闹钟：指定时间型的闹钟试响后仍会在设定时刻响。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', description: '闹钟 id。' } },
        required: ['id'],
      },
      output: textOutput({ ringing: { type: 'boolean' } }),
      execute: guard('试响闹钟', async (args) => {
        if (!alarms) return { ok: false, text: '闹钟服务不可用。' };
        const id = String(args.id ?? '');
        const result = await alarms.preview(id);
        return {
          ok: result?.ok === true,
          ringing: result?.ok === true,
          text:
            result?.ok === true
              ? `已试响闹钟 ${id}，弹窗应当出现在屏幕上。可以让用户把它拖到想要的位置，位置会被记住。`
              : `试响失败：${result?.error ?? '未知原因'}（通常是 Electron 助手没在运行，可以让用户去「设置 → 便签设置」点「启动服务」）。`,
        };
      }),
    },

    // --------------------------------------------------------------- capture
    {
      name: 'sticky_notes_screenshot',
      description:
        '发起一次屏幕截图：弹出全屏选区，**由用户**框选并标注，完成后可以选择存为便签或保存成图片。这个工具会等待用户操作完才返回，所以只在用户明确说要截图时调用。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: textOutput({ id: { type: 'string' }, path: { type: 'string' } }),
      execute: guard('截图', async () => {
        const result = await bridge.capture('note');
        if (result?.error !== undefined) return { ok: false, text: `截图失败：${result.error}` };
        if (result?.cancelled === true) return { ok: false, text: '用户取消了截图。' };
        const note = store.upsertNote({
          kind: 'shot',
          title: '截图',
          image: typeof result?.path === 'string' ? result.path : null,
          width: Number(result?.width) || 380,
          height: Number(result?.height) || 280,
        });
        store.flush();
        await bridge.openNote(note.id);
        return {
          ok: true,
          id: note.id,
          path: String(result?.path ?? ''),
          text: `截图已保存到 ${result?.path ?? '(未知路径)'}，并存为便签 ${note.id}（置顶显示）。`,
        };
      }),
    },
  ];

  return tools;
}

/**
 * The standing instructions for using these tools.
 *
 * Registered as a system-prompt section *and* as a skill. They are not redundant: the section is
 * always present, which is what stops the model from improvising with `pwsh` when it is in a hurry;
 * the skill carries the longer workflows and is loaded on demand, so the always-on text stays short
 * enough to be read rather than skimmed.
 */
export const USAGE_GUIDE = `## 桌面便签（sticky_notes_* 工具）

用户说"记一下""新建便签""贴个便签""提醒我""截个图"时，用 sticky_notes_* 工具，**不要**用 pwsh、不要自己写文件去凑 —— 那些做法用户看不到便签，也等得久。

| 想做的事 | 用哪个 |
|---|---|
| 新建一条便签 | \`sticky_notes_create\`（一次调用即出窗口） |
| 看有哪些便签 / 拿 id | \`sticky_notes_list\` |
| 看某条便签的完整内容 | \`sticky_notes_read\` |
| 改内容 / 颜色 / 位置 | \`sticky_notes_update\` |
| 把便签收起来（不删） | \`sticky_notes_hide\` |
| 把便签再调出来 | \`sticky_notes_show\` |
| 删掉便签 | \`sticky_notes_delete\` |
| 设一个到点弹窗的提醒 | \`sticky_notes_alarm_set\` |
| 看 / 改 / 删闹钟 | \`sticky_notes_alarm_list\` / \`_alarm_set\` / \`_alarm_delete\` |
| 让用户调闹钟弹出位置 | \`sticky_notes_alarm_ring\`，然后请用户把弹窗拖到想要的位置 |
| 截图（用户框选） | \`sticky_notes_screenshot\` |

便签是**真实的桌面置顶窗口**，不是聊天里的附件：用户切到别的程序也看得见，位置和隐藏状态会被持久化，重启 DSH 后还在。

**几条不要做错的事**：

- 便签**不是文件**。不要试图在会话里找便签的存储文件或"导出"便签；直接用工具。
- 删除是不可撤销的。用户只是嫌它挡着时，先考虑 \`sticky_notes_hide\`。
- \`sticky_notes_screenshot\` 会**阻塞等待用户在屏幕上框选**，只在用户明确要求截图时调用。
- 闹钟的 \`schedule.kind=once\` 用本地时刻字符串 \`"YYYY-MM-DDTHH:MM"\`，不要传时区偏移或 ISO 的 Z 结尾（那会被当成另一个时间）。
- 工具返回里带 \`ok: false\` 说明没做成，把 \`text\` 里的原因如实告诉用户，不要重试同样的调用。`;
