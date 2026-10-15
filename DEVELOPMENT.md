# Development

[中文](DEVELOPMENT.zh.md) | **English**

Engineering notes for `dsh-sticky-notes-desktop`: how it is put together, what the model-facing
contract is, and how to run the suites. User documentation lives in [README.md](README.md).

---

## Architecture

A DSH plugin has two halves; this one additionally ships a desktop helper:

```
┌─ DSH Electron renderer (a web page)──────────────────┐
│  lib/client.bundle.js   notes panel / settings / rail │
└───────────────┬──────────────────────────────────────┘
                │ same-origin fetch (connection-authenticated)
┌───────────────▼─ DSH Host (plain Node)───────────────┐
│  lib/index.js     mounting, lifecycle, sticky_notes_*    │
│  host/store.js    notes + settings on disk, atomic writes │
│  host/bridge.js   helper lifecycle + event write-back     │
│  host/routes.js   the browser's JSON surface              │
│  host/tools.js    the model-facing tools and their docs   │
└───────────────┬──────────────────────────────────────┘
                │ loopback TCP + NDJSON (token handshake)
┌───────────────▼─ Standalone Electron helper (own runtime)─┐
│  electron/main.mjs      window/hotkey/popup/capture dispatch │
│  electron/notes.mjs     always-on-top, snapping, auto-hide   │
│  electron/popup.mjs     the menu at the mouse                │
│  electron/capture.mjs   full-screen capture + annotator      │
└──────────────────────────────────────────────────────────┘
```

Three key design decisions, each also documented in the relevant file's comments:

1. **Why a separate Electron runtime is required.** DSH's host process runs under
   `ELECTRON_RUN_AS_NODE=1` as plain Node — no `BrowserWindow`, no `screen`, no `globalShortcut`. The
   only way to get a genuinely always-on-top window is to launch an Electron of your own. The plugin
   prefers to reuse the runtime `dsh-orb` has already downloaded
   (`~/.dsh/dsh-orb/electron-runtime`) and only downloads its own into
   `~/.dsh/sticky-notes/electron-runtime` if that is absent.

2. **Why TCP rather than stdio.** Measured: inside an Electron main process `process.stdin` has **no
   usable fd** — the stream reports `readable: true`, but `'end'` fires immediately and not a single
   byte arrives. stdout is fine, so the handshake (port + token) goes over stdout and everything else
   over loopback TCP. `dsh-orb` sidesteps stdio in the same way.

3. **Why the helper lock is per data directory rather than global.**
   `app.requestSingleInstanceLock()` locks per Electron binary, which would let "the helper for
   another profile" — or the plugin's own test suite — lock the user's helper out and report
   `already-running`. A lock has to be taken on the thing it protects, so it became a
   per-data-directory `helper.lock` recording a pid, reclaimed once that process is gone.

## The model-facing surface

`lib/host/tools.js` holds the twelve tools, the always-on system-prompt section (`USAGE_GUIDE`) and
the `sticky-notes` skill. Three constraints there fail *quietly*, and all three were established by
reading DSH's own implementation.

### `output.render` must return a `ContentBlock[]`, not a string

The registry does not check the shape — `snapshotProjection` only requires lossless JSON — so a
string passes registration *and* projection, and then breaks a consumer that calls `.some(…)` on
`result.content`.

> The exact thrower is `@deepseek-ai/dsh-spill-policy`'s `tools/post-execute` listener:
> `const content = decision.content ?? result.content; const hasImages = content.some(…)`. It is
> registered `{ prepend: true }`, enabled by default through `dsh-base`, runs on **every** tool
> result, and sits outside any `try` — so it throws *after* the tool body has already committed.
> That ordering makes the symptom deeply misleading: the note really was created, while the call
> was reported as an error.
>
> DSH does ship a validator with a perfect error message for this — `assertRenderedContent` in
> `dsh-cordis-host-runner`, which says *"it must return an ARRAY of content blocks"*. It is wired
> only into the sandboxed `harness.defineTool` path, so a plugin that calls `ctx.tools.register`
> directly never trips it. That is why the bug is silent.

Every tool DSH ships returns `[{ type: 'text', text }]`. So does this one, and the shared
`textOutput` helper coerces a returned string into that shape so a custom renderer cannot
reintroduce it. An array is passed through untouched, because DSH supports multi-block results
(text plus an image) and coercing would silently drop the extra blocks.

### `additionalProperties` is mandatory on every object node

`ctx.tools.register` runs DSH's JSON-Schema subset check over both `parameters` and `output.schema`.
The subset is stricter than "valid JSON Schema": `additionalProperties` must be explicitly `true` or
`false` on **every** object node, `oneOf` may not be combined with `type`, and
`$ref` / `allOf` / `pattern` / `format` / numeric bounds are all rejected.

A violation throws inside the per-tool `try`, so that one tool quietly disappears from the model's
list. `tools/check-tool-schemas.mjs` enforces the subset in the suite rather than in production.

### A skill's `whenToUse` never reaches the model

DSH shows the model a catalog of `name: description` only, truncated at 500 characters; `whenToUse`
and `path` are not rendered. A skill that describes *what it is* in `description` while putting *when
to use it* in `whenToUse` therefore produces an entry the model has no reason to open — **the trigger
phrases have to be in `description`**.

### The bug that made all of this invisible

The first version registered **one** tool named `sticky_notes` with an `action` enum, like this:

```js
ctx.inject(['tools'], (toolCtx) => toolCtx.tools.register({ … }));
```

An `inject` callback receives a context that **does not carry the service as a property** — you reach
it with `ctx.get(name)`. So `toolCtx.tools` was `undefined`, the surrounding `try` turned the
`TypeError` into a `log.warn` nobody reads, and the plugin shipped with **no model tools at all**.

Nothing failed loudly. The model simply had no `sticky_notes` tool, so every "make me a note" was
improvised out of `pwsh` and file reads — which is exactly what "slow, and bad at it" was.

The fix is the convention DSH's own plugins use: declare `tools` in the `inject` export and reach it
as `ctx.tools`. Measured while diagnosing this: creating a note and showing its window takes
**130–155 ms** on the host side, and every other operation is ~3 ms — the host was never the slow
part.

## Tests

`npm test` runs everything that needs no DSH instance:

```bash
npm run build     # concatenate lib/ui/*.js + lib/client.js into lib/client.bundle.js
npm test          # every suite that needs no DSH instance
npm run check:readme    # verify every relative link in both READMEs resolves
npm run check:schemas   # verify the tool schemas match DSH's enforced subset
```

The browser half must be **a single self-contained file** (DSH serves exactly one file; a sibling
`import` would 404). So the sources are split under `lib/ui/`, stitched together through the
`globalThis.__dshSticky` namespace, and concatenated verbatim by `tools/build-client.mjs`.
**Edit `lib/client.js` or `lib/ui/*.js` — never hand-edit the bundle.**

| Test | Covers |
|---|---|
| `tools/test-geometry.mjs` | Snap / hide / reveal / landing geometry: 83 cases, 65k+ assertions, including randomised invariants |
| `tools/test-package.mjs` | The package contract (entry points, patch, self-contained bundle, every runtime asset covered by `files`) plus `apply` not throwing in a hostile context |
| `tools/test-client-load.mjs` | Loads the bundle the way DSH really does: slot registration, components rendering, hotkey recording, colour helpers, and that the labels carry (or omit) the package name as intended |
| `tools/test-tool-registration.mjs` | **The model-facing surface**: `inject` declares `tools`, all twelve tools register with the `output` schema and `render` DSH requires, every `execute` returns lossless JSON, `textOutput` normalises a string renderer into content blocks, and the prompt section and skill carry real content. Its fake context is faithful to Cordis |
| `tools/check-tool-schemas.mjs` | Every object node declares `additionalProperties`, and no rejected keyword appears |
| `tools/check-readme-links.mjs` | Both READMEs' relative links resolve, each links to the other, and every image they display is actually shipped |
| `tools/test-electron-helper.mjs` | Real Electron: handshake, real windows, snapping, auto-hide, sliding back, reporting a hotkey conflict faithfully (never substituting a key), creating a note via hotkey, full-screen capture, clean exit |
| `tools/test-popup.mjs` | Popup behaviour: appears at the mouse, disappears when the mouse leaves, closes on Escape, opens again afterwards, and "new note" really creates a note |
| `tools/test-popup-appearance.mjs` | Both rows render, exactly 168×88 with no overflow (a transparent window clips overflow away) |
| `tools/test-alarm-schedule.mjs` | When each of daily / weekdays / one-time should fire, no repeat within a minute, catch-up after a miss, and `2026-02-30` or a non-zero-padded time rejected |
| `tools/test-alarm-ring.mjs` | Alarms really ring: the Electron popup becomes visible, firing is recorded, dismissal is recorded, deleting leaves no orphan window, alarms never leak into the notes list |
| `tools/test-shot-actions.mjs` | The three screenshot buttons, in the real annotator, including that the note lands at the selected position |
| `tools/test-hide-modes.mjs` | Both hide styles with real windows: `offscreen` parks a 260px note at `x=-259`, `tab` folds it to 36×120, and either slides back |
| `tools/test-note-appearance.mjs` | Real Electron renders 3 colour schemes, asserting the text colour reaches the title bar and body, with contrast ≥ 4.5:1 |
| `tools/test-helper-service.mjs` | The real lifecycle stopped → start → restart → stop → start again; "process alive but not answering" reports unresponsive |
| `tools/test-bridge.mjs` | Host bridge integration: the helper starts, events write back to the store, a hidden note is restored after a simulated restart, everything releases cleanly |

Three further suites need a DSH instance, and two of those also need a Chromium with
`--remote-debugging-port`:

```bash
dsh --profile <temp-profile> --port 0 --no-open   # note the port and token from stdout
node tools/test-live.mjs <port> <token>
node tools/test-ui.mjs <port> <token> <cdpPort>
node tools/test-alarm-ui.mjs <port> <token> <cdpPort>
node tools/test-service-ui.mjs <port> <token> <cdpPort>
```

Two tools verify an **installed** copy rather than this checkout:

| Tool | Purpose |
|---|---|
| `tools/verify-install.mjs <profileDir> <packageName>` | Whether an installed bundle resolves and loads: the package name, `dsh.bundle.patch`, the patch's own `name`, `exports["./client"]`, and a real `import` plus `apply`. **Run this first after a rename or reinstall** — every one of those mismatches surfaces as a bare `failed to import` that does not say which string is wrong |
| `tools/read-installed-name.mjs <profileDir> <packageName>` | What name an installed bundle will actually show, read from the browser bundle in `node_modules`. With a `link:` install that is this same file; with a `.tgz` install it is not, so use it to confirm a distribution build |

## Publishing

Published as [`dsh-sticky-notes-desktop`](https://www.npmjs.com/package/dsh-sticky-notes-desktop). Anyone
installs it with `install_bundle("dsh-sticky-notes-desktop")`.

The workflow for a new version:

```bash
npm version patch|minor|major   # bumps package.json and tags the commit
git push --follow-tags
npm publish
npm view dsh-sticky-notes-desktop version   # confirm what actually landed
```

Three things about publishing this package that are easy to get wrong:

1. **`prepack` is a safety net, not a formality.** It runs `build-client.mjs --check`, which fails if
   `lib/client.bundle.js` is older than the `lib/ui/*.js` sources it is built from. Never publish with
   `--ignore-scripts`; that flag turns a stale bundle into a shipped bug.
2. **A version number is permanent.** Once a version is published it can never be reused, even after
   `npm unpublish`, so check with `npm publish --dry-run` before committing to one.
3. **Registry ingestion is asynchronous.** `npm publish` can return *"Your package is being processed"*
   while `npm view` still shows the previous state — and for a brand-new package name it briefly shows
   a `0.0.0-stage` placeholder while npm reserves the name. This is npm's staged-publishing mechanism,
   not a failed or hijacked publish. Wait, then check the registry again before concluding anything.

Relevant facts, all established by reading DSH's plugin manager:

1. `dsh.bundle.patch` is the **only** required manifest field; `private: true` is fine.
2. `install_bundle` accepts an absolute directory, an absolute `.tgz`, a git URL, or a registry name.
   Relative paths are refused.
3. `files` matters only for `.tgz`/npm installs. A `link:` install symlinks the source directory, so a
   file left out of `files` works locally and is missing for everyone else — `test-package.mjs` derives
   the reachable asset set from the code and checks it against `files` for exactly this reason.
4. No lifecycle scripts ship, so `approvedBuilds` is never needed.
5. The plugin declares no `@deepseek-ai/dsh-*` peers, so the install-time compatibility check has
   nothing to reject.
6. The plugin-list card title is a literal in `locale/zh.json`, because DSH reads that JSON before any
   plugin code runs. It is the one string a rename must be edited by hand.

`docs/` holds only screenshots the READMEs actually display. Because `files` lists the directory as a
whole, any image dropped in there ships whether or not anything references it, so unused ones are
deleted rather than left behind.

## License

MIT
