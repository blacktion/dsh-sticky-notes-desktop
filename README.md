# dsh-sticky-notes-desktop

[中文](README.zh.md) | **English**

Desktop sticky notes and screenshot annotation for **DeepSeek Harness**. The notes are **real, always-on-top OS windows** — switching to another app or minimising DSH will not cover them.

- **Hotkey notes** — a hotkey pops up a "new note / screenshot" menu at the mouse. Notes drag and resize freely, and snap to a screen edge and tuck themselves away when you drop them near one.
- **They come back** — position and hidden state are saved as you work, so closing and reopening DSH returns every note (including hidden ones) to where it was.
- **Note alarms** — set a note to appear on top at a time you choose: every day, on weekdays, or once.
- **Ask for one in conversation** — `sticky_notes_*` tools let the model create, read, move, hide and delete notes, and set alarms.

---

## The UI

The sidebar entry reads **便签**; the panel has two tabs, **便签** / **便签闹钟**:

![The notes panel](docs/panel-with-note.png)

"Settings → **便签设置**" is its own page — hotkey recording, colours, opacity, font size, snap and hide behaviour, service status, with a live preview:

![Sticky-notes settings](docs/settings.png)

## 便签闹钟 (note alarms)

"At a given time, put this in front of me." Switch the panel to the **便签闹钟** tab.

![An alarm popup](docs/alarm-text.png)

| Field | Meaning |
|---|---|
| Content | **Text** or an **image** (chosen with the system file dialog; png/jpg/gif/webp/bmp) |
| Every day | `HH:MM` daily |
| Weekdays | `HH:MM` Monday–Friday |
| One time | A specific date and time, **fires once** |
| Row buttons | Test / Edit / Enable-disable / Delete, plus "Stop ringing" while it is ringing |
| **Position** | Defaults to **dead centre**; press **Test**, drag the popup where you want it, and the position is remembered |

**Behaviour**

- It takes no screen space until the moment arrives, then shows an **always-on-top window** with your text or image.
- Press 关闭, hit `Esc`, or right-click the window to end that reminder.
- One alarm, one window — two firing at once do not close each other.
- **A missed alarm still rings.** If DSH was not running when it came due, the next start fires it immediately. An alarm may be late, but it must not vanish silently.
- It fires at most once per minute, so polling cannot produce duplicates.
- The popup is transient and never "restored": closing it means it is gone.

### Choosing where it appears

**Test doubles as the position picker:**

1. Press **Test** in the editor (**available before you save**, too);
2. **Drag** the popup where you want it;
3. Close it — the editor's "position" shows the coordinates you left it at;
4. Save. That alarm now appears there.

"Reset position" returns it to the centre.

> Test does not consume an alarm: it never writes `lastFiredAt`, so a one-time alarm **still fires at its appointed moment**. Testing an unsaved alarm writes nothing at all.
>
> A saved position that falls on a screen that no longer exists (an unplugged monitor, a changed resolution) is clamped back into view when the alarm fires — otherwise it would appear somewhere invisible and could not be dismissed.

## Installation

**The easy way — DSH's own plugin manager.** Open **插件**, press **添加插件**, type the package name, and
press **安装**:

![Adding the plugin in DSH](docs/install-dialog.png)

```
dsh-sticky-notes-desktop
```

That is all it takes — no clone, no terminal. The dialog accepts an npm package name, a GitHub repository
address, or a local directory path.

> The **安装源** selector above the warning is worth a look first: it defaults to the China mainland mirror,
> which is the right choice there and the wrong one elsewhere. Switch it to the default registry if you are
> not in China and the install is slow or fails.

Then **restart DSH**: a profile's bundle list is only read at startup.

The methods below do the same thing from the conversation side, for when you would rather not use the GUI.

**From npm**

```
plugin_manager(action="install_bundle", target="dsh-sticky-notes-desktop")
```

The package is [`dsh-sticky-notes-desktop`](https://www.npmjs.com/package/dsh-sticky-notes-desktop) — the easiest route, since it needs neither a clone nor a local `npm pack`.

**From this repository**

```
plugin_manager(action="install_bundle", target="<absolute path to this checkout>")
```

The path **must be absolute** (relative paths are refused). A local directory is recorded as a `link:`, so editing the code and restarting DSH is enough — useful while developing.

**From a packed tarball**

```bash
npm pack    # produces dsh-sticky-notes-desktop-<version>.tgz
```

```
plugin_manager(action="install_bundle", target="<absolute path to the .tgz>")
```

The tarball is copied into the profile rather than linked, so it works on other machines.

> `~/.dsh/profiles/desktop` is managed exclusively by the Electron application, and `dsh --profile desktop` is refused. Install through the in-app plugin manager, or edit that profile's `package.json` directly.

### Notes on installing

| | |
|---|---|
| The only required manifest field | `dsh.bundle.patch` — that single field is DSH's whole "is this a bundle?" test |
| Accepted `target` forms | An absolute directory, an absolute `.tgz` (local or over http), a git URL, or an npm package name. **Relative paths are refused.** |
| The browser half must be pre-built | DSH does not build at install time. `npm pack` runs a `prepack` check that the shipped bundle is current. |
| `files` matters for `.tgz`/npm only | A `link:` install symlinks the source directory, so missing files there fail only for everyone else. A test guards it. |

## First run

The default hotkey **Ctrl + Alt + S** pops up a menu at the mouse; choose "new note" or "screenshot".

The default note is **black at 80% opacity with light text** (`#000000` / `0.8` / `#f5f5f5`):

![The default black note](docs/note-black.png)

Colour, opacity and text colour are changed in "Settings → 便签设置".

The **text colour** applies to the note's own content — its title and body. The toolbar's controls
deliberately do **not** follow it: buttons, the type mark, the title-bar divider and the input hints
take a colour derived from the note's **background** instead, so they stay legible whatever text colour
you choose. Pick a dark text colour on a black note and the body becomes your business, but 「保存」 and
「关闭」 remain readable.

---

## Keyboard shortcuts

| Action | Key |
|---|---|
| Open the menu | `Ctrl+Alt+S` by default; any combination can be set in settings |
| Screenshot: confirm the selection / save the image | `Enter` |
| Screenshot: save as a note | `Ctrl+Enter` |
| Screenshot: copy to the clipboard | `Ctrl+C` |
| Screenshot: undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Screenshot: select the whole screen / cancel | `Ctrl+A` / `Esc` |
| Note: save a draft | `Ctrl+S` |

The hotkey is **system-wide** (Electron `globalShortcut`), so it fires even when DSH is not in the foreground.

### A taken hotkey is reported, never silently replaced

The default is **`Ctrl+Alt+S`**, and what gets registered is **always exactly the combination you set**. Quietly substituting another key would mean you press the right combination and nothing happens, so instead the conflict is stated plainly and you decide what to change.

When there is a conflict you will see it in three places: a **red banner at the top of "Settings → 便签设置"** naming the taken combination, the **notes panel's footer turning red**, and a red notice inline the moment you record a conflicting combination.

`Ctrl+Alt+S` is heavily contested — Windows 11's Snipping Tool and various screen recorders claim it. `Ctrl+Shift+S`, `Ctrl+Shift+Alt+S` and `Ctrl+Alt+Shift+N` are usually free.

## A note created with the hotkey is a draft

A note created with the hotkey **enters the list only after you press Save**:

- The title bar shows an **`未保存`** badge until you save;
- Anything you type lives only in that window and is **never written to `data.json`**;
- **Closing (or deleting) it outright leaves nothing behind** — no row appears in the list;
- Pressing Save (or `Ctrl+S`) makes it appear in the sidebar list immediately, after which every edit is saved automatically.

> "Close" means different things for the two kinds of note: for a **saved** note it just puts the window away and the content stays in the list; for a **draft** it discards it.
>
> "New note" from the sidebar list takes a different path — the host creates it directly, so it is **in the list immediately**.

## Edge snapping / auto-hide

- Drag a note within 12px of a screen edge and it snaps to it (the distance is configurable).
- After a brief pause it hides itself. **The default is to move the whole note off-screen**, leaving a 1px sliver at the edge.
- Push the mouse against that edge (after 120ms by default) and the note slides back; move the mouse away and it hides again.
- While hidden the window is **click-through**, so it does not block what is underneath it.

> The 1px sliver is deliberate rather than 0: a window moved fully off-screen can only be recalled by moving the pointer to a spot where nothing is drawn. One pixel is invisible but keeps the edge hittable.

### "保留" (keep out)

The note's title bar has a **`保留`** button:

- Press it → it becomes **`取消保留`** (highlighted), and that note **no longer snaps and never auto-hides** — it stays where you put it;
- Press it again → normal behaviour returns.

A kept-out note may also **hang past the left, right or bottom screen edge**, which is what makes "leave
it exactly here" usable — a note parked half off the right edge is out of the way and still readable.

- At least **40px stays on screen**, so it can always be grabbed again.
- The **top edge is the exception**: it stays flush. The title bar is the only place a note can be dragged
  from, so a note hanging off the top would push its own handle off screen and could never be moved back.

The state is saved in `data.json` and survives a restart. The sidebar list offers the same button.

## Screenshots and annotation

Drag out a region, then draw rectangles, ellipses and arrows, use a freehand pen, and type text; 8 colours, 3 line weights, undo / redo / clear. Three exits:

| Button | Behaviour |
|---|---|
| **Save image** | Opens the system **save dialog** so you choose the location and filename; cancelling keeps you in the editor |
| **Save as note** | Becomes an **always-on-top** screenshot note **at the position you selected**, exactly like a hand-made note |
| **Copy** | Writes to the system clipboard |

What gets exported is the **clean selected region** — the dimming mask, toolbar and size label never bleed in.

## Data

| Path | Contents |
|---|---|
| `~/.dsh/sticky-notes/data.json` | Note index + alarms + settings |
| `~/.dsh/sticky-notes/shots/<id>.png` | Pixels for screenshot notes |
| `~/.dsh/sticky-notes/shot-notes/shot-*.png` | Images from "save as note" |
| `~/.dsh/sticky-notes/helper.lock` | Pid of the process holding the helper |
| `~/.dsh/sticky-notes/electron-runtime/` | A self-provided Electron runtime, if any |

The index is written **atomically** (temp file + rename); a corrupt file is renamed aside and rebuilt rather than preventing the plugin from loading.

## Service status (Settings → 便签设置)

At the top of the settings page is a **便签服务** status answering "can it actually pop a window right now?":

| Display | Meaning |
|---|---|
| 🟢 **正在运行** | The process is up **and actually answered** — with the display count, active hotkey, PID and Electron path |
| 🟡 **无响应** | The process exists but no longer answers — typically a stale process after a plugin upgrade. **Press 重启服务** |
| 🔴 **未运行** | Not running, or it failed to start (the reason is printed) |

Buttons: **启动服务** / **重启服务** / **停止服务** / **刷新状态**.

> The status is not "the host remembers starting it" but **a question actually asked of it**. The two differ exactly when things go wrong: a wedged helper still looks healthy to the host, and fixing that is why "restart" exists — so that case must read **无响应**, not **正在运行**.

## Settings

| Setting | Meaning |
|---|---|
| Hotkey | Click, then press a combination to record it; at least one modifier |
| Background / text colour | 8 presets plus a colour picker |
| Opacity | 20%–100%, with a live preview |
| Font size | 8–72px |
| **Hide style** | **Move off-screen (default) / edge tab** |
| Snap distance | How close to an edge counts as snapping |
| Auto-hide delay | How long a snapped note waits before hiding |
| Reveal delay | How long after the mouse reaches the edge the note slides back |
| Start with DSH | When off, the helper is no longer launched automatically |

Below the settings, the page names the **installed version** and says whether a newer one is on npm:
**update available vX.Y.Z** (click to check again) or **up to date**. Nothing is shown when the package was
not installed from the registry — a local directory or a `.tgz` has no published counterpart to compare
against — and a failed check stays silent too, since an offline machine should not be told off for it.

> A note window **has no colour button of its own**: colour is a preference, and preferences live in one place — 便签设置. The title bar carries only Save / Keep out / Close / Delete (screenshot notes add "Save as").

## For the model

The plugin gives the model a documented surface rather than leaving it to improvise. Twelve tools, one per operation:

`sticky_notes_list` · `sticky_notes_create` · `sticky_notes_read` · `sticky_notes_update` ·
`sticky_notes_delete` · `sticky_notes_show` · `sticky_notes_hide` ·
`sticky_notes_alarm_list` · `sticky_notes_alarm_set` · `sticky_notes_alarm_delete` ·
`sticky_notes_alarm_ring` · `sticky_notes_screenshot`

Alongside them, a **system-prompt section** (always present, so the model does not reach for a shell when asked for a note) and a **`sticky-notes` skill** carrying the longer workflows.

## Troubleshooting

**The hotkey does nothing.** In order of likelihood:

1. **DSH has not been restarted.** Both the host half and the helper are loaded at startup, and the helper keeps running old code until then.
2. **Another application owns the combination.** Look for the red banner in "Settings → 便签设置"; the notes panel's footer also turns red. Record another combination under "open menu".
3. **The helper did not start.** The banner on the 便签设置 page states the reason:
   - *Electron runtime not found* → the first run downloads ~120MB; check your network, or point `DSH_STICKY_NOTES_ELECTRON` at an existing Electron executable.
   - *Another sticky-notes helper is using the same data directory* → another DSH instance is open; close it first.

**The popup does not disappear when clicking outside.** It closes when you pick an item, press `Esc`, or move the mouse away — "clicking outside" works because the popup gets out of the way and the click lands where you meant.

**Note windows do not appear.** See item 3 above; also check that "start with DSH" has not been turned off.

**The model ignores the plugin and does everything with a shell.** It cannot see the tools, which means the plugin did not register them — check that the `sticky_notes_*` tools appear in the session's tool list, and restart DSH.

**Degraded behaviour.** When the helper cannot start, neither the plugin nor DSH crashes: the note list, editing, deleting and settings all keep working, and only the always-on-top windows are unavailable.

## Known limitations

- **One DSH instance at a time**: the helper locks per data directory, so a second instance reports the conflict explicitly instead of popping up duplicate windows.
- **A screenshot covers only the display the mouse is on**: with multiple monitors, position the pointer on the target screen first.
- **`hiddenRevealWidth` is deprecated**: the tab is a fixed 36px, bounded below by the platform's minimum window width.

## License

MIT
