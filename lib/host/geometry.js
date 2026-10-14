/**
 * dsh-sticky-notes — edge snapping / auto-hide geometry.
 *
 * Pure functions only: no fs, no Electron, no timers. That keeps the trickiest
 * logic in the plugin unit-testable and identical between the Electron main
 * process and any future non-Electron fallback.
 *
 * Coordinate space: **screen DIP**, origin at the top-left of the primary
 * display. A note is a rectangle `{ x, y, width, height }`.
 *
 * @module dsh-sticky-notes/host/geometry
 */

/** Edge identifiers, in the order we prefer when two edges tie. */
export const EDGE_LEFT = 'left';
export const EDGE_RIGHT = 'right';
export const EDGE_TOP = 'top';
export const EDGE_BOTTOM = 'bottom';

/**
 * Find the display whose work area contains the rectangle's centre.
 * Falls back to the first display, then to a synthetic 1920x1080 area, so a
 * caller can never dereference `undefined` when no display reports itself.
 *
 * @param {{workArea: {x:number,y:number,width:number,height:number}}[]} displays
 * @param {{x:number,y:number,width:number,height:number}} rect
 */
export function displayFor(displays, rect) {
  const list = Array.isArray(displays) ? displays.filter((d) => d?.workArea !== undefined) : [];
  if (list.length === 0) return { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };

  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  for (const display of list) {
    const a = display.workArea;
    if (cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height) return display;
  }
  return list[0];
}

/**
 * Snap a rectangle to the nearest screen edge when it is within `threshold` px.
 *
 * Only one edge is reported, the closest one, because a note glued to a corner
 * would otherwise have to hide along two axes and the reveal maths stops being
 * predictable. Ties resolve left → right → top → bottom.
 *
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {{x:number,y:number,width:number,height:number}} workArea
 * @param {number} threshold
 * @returns {{ edge: string|null, x: number, y: number, distance: number }}
 *          `edge === null` means "not near any edge"; x/y are unchanged.
 */
export function snapToEdge(rect, workArea, threshold) {
  const limit = Number.isFinite(threshold) ? Math.max(0, threshold) : 0;
  const left = rect.x - workArea.x;
  const right = workArea.x + workArea.width - (rect.x + rect.width);
  const top = rect.y - workArea.y;
  const bottom = workArea.y + workArea.height - (rect.y + rect.height);

  const candidates = [
    { edge: EDGE_LEFT, distance: left },
    { edge: EDGE_RIGHT, distance: right },
    { edge: EDGE_TOP, distance: top },
    { edge: EDGE_BOTTOM, distance: bottom },
  ].sort((a, b) => a.distance - b.distance);

  const best = candidates[0];
  if (best === undefined || best.distance > limit) {
    // Still clamp fully off-screen notes back into view, even when not snapping.
    return { edge: null, x: clampX(rect.x, rect.width, workArea), y: clampY(rect.y, rect.height, workArea), distance: best?.distance ?? 0 };
  }

  const snapped = { x: rect.x, y: rect.y };
  if (best.edge === EDGE_LEFT) snapped.x = workArea.x;
  if (best.edge === EDGE_RIGHT) snapped.x = workArea.x + workArea.width - rect.width;
  if (best.edge === EDGE_TOP) snapped.y = workArea.y;
  if (best.edge === EDGE_BOTTOM) snapped.y = workArea.y + workArea.height - rect.height;

  return { edge: best.edge, x: snapped.x, y: snapped.y, distance: best.distance };
}

/** Keep a rectangle horizontally inside the work area. */
export function clampX(x, width, workArea) {
  if (width >= workArea.width) return workArea.x;
  return Math.min(workArea.x + workArea.width - width, Math.max(workArea.x, x));
}

/** Keep a rectangle vertically inside the work area. */
export function clampY(y, height, workArea) {
  if (height >= workArea.height) return workArea.y;
  return Math.min(workArea.y + workArea.height - height, Math.max(workArea.y, y));
}

/**
 * Geometry for an edge-hidden note.
 *
 * Two modes, because they trade discoverability against tidiness:
 *
 * - **`offscreen`** (the default): the note slides out of the display entirely,
 *   leaving only a {@link OFFSCREEN_SLIVER} px edge of it on screen. Measured on
 *   Windows, a window really can be placed at `x = workArea.right` and reports
 *   0.0% visible — so "hide completely outside the screen" is achievable, contrary
 *   to the assumption the first implementation was built on. The sliver exists so
 *   the note keeps a physical, hittable edge: a note parked at 0% visible can only
 *   be recovered by moving the pointer to a coordinate with nothing there to aim
 *   at.
 * - **`tab`**: the note collapses into a {@link TAB_THICKNESS} px taskbar-like tab
 *   at the edge, centred on its old span. Deliberately *not* thinner: Electron
 *   enforces a minimum window width on Windows (~32 px measured), so anything
 *   smaller is silently grown by the OS and the geometry stops matching reality.
 *
 * In both modes the along-edge position is clamped into the work area. Without
 * that clamp a note whose span lies mostly off-screen (which snap-to-edge allows —
 * it only ever aligns the one nearest edge) would collapse somewhere the pointer
 * cannot reach, i.e. a note that can never be brought back.
 *
 * @param {{edge:string|null, x:number, y:number, width:number, height:number}} note
 * @param {{x:number,y:number,width:number,height:number}} workArea
 * @param {'offscreen'|'tab'} [mode]
 * @returns {{x:number, y:number, width:number, height:number}}
 */
export function hiddenBounds(note, workArea, mode = HIDE_MODE_OFFSCREEN) {
  const onLeft = note.edge === EDGE_LEFT;
  const onRight = note.edge === EDGE_RIGHT;
  const onTop = note.edge === EDGE_TOP;
  const onBottom = note.edge === EDGE_BOTTOM;

  if (!onLeft && !onRight && !onTop && !onBottom) {
    // No edge recorded: nothing to collapse against, so stay put. The caller
    // decides whether to hide by other means.
    return { x: note.x, y: note.y, width: note.width, height: note.height };
  }

  const vertical = onLeft || onRight;
  const span = vertical ? note.height : note.width;
  const along = vertical ? note.y : note.x;

  if (mode === HIDE_MODE_TAB) {
    const tab = Math.max(TAB_MIN_SPAN, Math.min(span, TAB_SPAN));
    const centred = Math.round(along + (span - tab) / 2);
    const alongStart = vertical ? clampY(centred, tab, workArea) : clampX(centred, tab, workArea);

    if (onLeft) return { x: workArea.x, y: alongStart, width: TAB_THICKNESS, height: tab };
    if (onRight) {
      return { x: workArea.x + workArea.width - TAB_THICKNESS, y: alongStart, width: TAB_THICKNESS, height: tab };
    }
    if (onTop) return { x: alongStart, y: workArea.y, width: tab, height: TAB_THICKNESS };
    return { x: alongStart, y: workArea.y + workArea.height - TAB_THICKNESS, width: tab, height: TAB_THICKNESS };
  }

  // offscreen: keep the note's own size, push it out until `sliver` px remain.
  // Vertical position is clamped so the remaining edge is always within the work
  // area vertically (and vice versa).
  const sliver = OFFSCREEN_SLIVER;
  const y = clampY(note.y, note.height, workArea);
  const x = clampX(note.x, note.width, workArea);

  if (onLeft) return { x: workArea.x - note.width + sliver, y, width: note.width, height: note.height };
  if (onRight) {
    return { x: workArea.x + workArea.width - sliver, y, width: note.width, height: note.height };
  }
  if (onTop) return { x, y: workArea.y - note.height + sliver, width: note.width, height: note.height };
  return { x, y: workArea.y + workArea.height - sliver, width: note.width, height: note.height };
}

/**
 * The revealed (on-screen) rectangle for a note, i.e. where it sits when shown.
 * @param {{x:number,y:number,width:number,height:number}} note
 */
export function revealedBounds(note) {
  return { x: note.x, y: note.y, width: note.width, height: note.height };
}

/**
 * How far in from the edge the pointer may be and still reveal the note.
 *
 * The zone is anchored on the screen edge rather than on the note's own rectangle,
 * because in `offscreen` mode only {@link OFFSCREEN_SLIVER} px of the note is on
 * screen — a target far too fine to aim at, and one the pointer reaches only by
 * overshooting the edge. Anchoring to the edge means the user just pushes the
 * pointer at the edge, wherever along it they happen to be within the note's span.
 */
export const REVEAL_SLACK = 8;

/**
 * The strip a pointer must enter to reveal a hidden note.
 *
 * Spans from the screen edge inward by {@link REVEAL_SLACK} px plus however much of
 * the note is on screen, across the note's span along that edge. Because the zone
 * hugs a screen edge — where the user rarely aims at anything else — the extra
 * margin costs nothing.
 *
 * @param {{edge:string|null, x:number, y:number, width:number, height:number}} note
 * @param {{x:number,y:number,width:number,height:number}} workArea
 * @param {number} [slack]
 * @param {'offscreen'|'tab'} [mode]
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
export function revealZone(note, workArea, slack = REVEAL_SLACK, mode = HIDE_MODE_OFFSCREEN) {
  if (note.edge === null || note.edge === undefined) return null;
  if (![EDGE_LEFT, EDGE_RIGHT, EDGE_TOP, EDGE_BOTTOM].includes(note.edge)) return null;
  const pad = Number.isFinite(slack) ? Math.max(0, slack) : REVEAL_SLACK;
  const hidden = hiddenBounds(note, workArea, mode);
  const zone = { ...hidden };

  // Always take in the screen edge itself, whatever the hidden rectangle looks
  // like: in `offscreen` mode only a 1 px sliver is on screen, and the pointer
  // arrives at the very edge, so the zone must reach it.
  if (note.edge === EDGE_LEFT) {
    zone.x = workArea.x;
    zone.width = Math.max(hidden.x + hidden.width - workArea.x, 1) + pad;
  } else if (note.edge === EDGE_RIGHT) {
    const edgeX = workArea.x + workArea.width;
    zone.x = Math.min(hidden.x, edgeX - 1) - pad;
    zone.width = edgeX - zone.x;
  } else if (note.edge === EDGE_TOP) {
    zone.y = workArea.y;
    zone.height = Math.max(hidden.y + hidden.height - workArea.y, 1) + pad;
  } else {
    const edgeY = workArea.y + workArea.height;
    zone.y = Math.min(hidden.y, edgeY - 1) - pad;
    zone.height = edgeY - zone.y;
  }

  return zone;
}

/** True when a point lies inside a rectangle. */
export function pointInRect(point, rect) {
  if (rect === null || rect === undefined) return false;
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * Should this hidden note be revealed for the given pointer position?
 * @param {{edge:string|null, x:number, y:number, width:number, height:number}} note
 * @param {{x:number,y:number}} point
 * @param {{x:number,y:number,width:number,height:number}} workArea
 * @param {number} revealWidth
 * @returns {boolean}
 */
export function shouldReveal(note, point, workArea, revealWidth) {
  return pointInRect(point, revealZone(note, workArea, revealWidth));
}

/** Minimum size a note window may be resized to. */
export const MIN_NOTE_WIDTH = 140;
export const MIN_NOTE_HEIGHT = 90;

/** How a note hides at a screen edge. */
export const HIDE_MODE_OFFSCREEN = 'offscreen';
export const HIDE_MODE_TAB = 'tab';

/**
 * How much of an off-screen-hidden note stays on screen, in px.
 *
 * 1 px is enough for `setBounds` to keep the window legally on the display (and
 * for the pointer to have something to reach), while being effectively invisible.
 * Measured: asking for `x = workArea.right` yields 0.0% visible, which is real
 * hiding with nothing to aim at — hence the sliver.
 */
export const OFFSCREEN_SLIVER = 1;

/** Thickness of a `tab`-mode hidden note, in px. */
export const TAB_THICKNESS = 36;

/** The tab's span along the edge — a comfortable click target. */
export const TAB_SPAN = 120;

/** Floor for the tab span, so even a tiny note leaves a grabbable handle. */
export const TAB_MIN_SPAN = 56;

/**
 * Apply resize constraints to a proposed size.
 * @param {number} width
 * @param {number} height
 */
export function constrainSize(width, height) {
  return {
    width: Math.max(MIN_NOTE_WIDTH, Math.round(Number.isFinite(width) ? width : MIN_NOTE_WIDTH)),
    height: Math.max(MIN_NOTE_HEIGHT, Math.round(Number.isFinite(height) ? height : MIN_NOTE_HEIGHT)),
  };
}

/**
 * Pick a spawn rectangle that does not cover the popup the user just clicked.
 * Walks a short spiral of candidate offsets and returns the first that is fully
 * inside the work area.
 *
 * @param {{x:number,y:number}} anchor   pointer position
 * @param {number} width
 * @param {number} height
 * @param {{x:number,y:number,width:number,height:number}} workArea
 * @returns {{x:number, y:number}}
 */
export function placeNear(anchor, width, height, workArea) {
  const size = constrainSize(width, height);
  const offsets = [
    [24, 24],
    [40, 40],
    [-size.width - 24, 24],
    [24, -size.height - 24],
    [-size.width - 24, -size.height - 24],
    [0, 0],
  ];
  for (const [dx, dy] of offsets) {
    const x = clampX(anchor.x + dx, size.width, workArea);
    const y = clampY(anchor.y + dy, size.height, workArea);
    if (x >= workArea.x && y >= workArea.y) return { x, y };
  }
  return { x: clampX(anchor.x, size.width, workArea), y: clampY(anchor.y, size.height, workArea) };
}
