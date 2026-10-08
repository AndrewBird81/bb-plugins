// DOM helpers shared by the host overlay (inside BB) and the guest page.
//
// Both sides describe positions the same way: an anchor id for an element
// both sides render, plus fractions of its box (cursors) or character
// offsets into its text (selections). Each side supplies a resolver that maps
// a region and anchor to its own element.
import type { Participant, Region, ScrollPoint, Selection, TextPoint } from "./shared";

/** Maps a region and anchor id to this side's element; a null anchor means the region itself. */
export type Resolver = (region: Region, anchor: string | null) => HTMLElement | null;

/** Where a node sits: its region and the anchor element/id around it. */
export type Locator = (node: Node) => { region: Region; element: HTMLElement; anchor: string } | null;

/** The element whose text selection offsets count from: the message body when there is one. */
export function textBase(element: HTMLElement): HTMLElement {
  return element.querySelector<HTMLElement>("[data-markdown-preview]") ?? element;
}

function offsetWithin(base: HTMLElement, node: Node, offset: number): number {
  if (!base.contains(node)) {
    const position = base.compareDocumentPosition(node);
    return position & Node.DOCUMENT_POSITION_PRECEDING ? 0 : (base.textContent ?? "").length;
  }
  const range = document.createRange();
  range.setStart(base, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

function pointAt(base: HTMLElement, offset: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const length = node.data.length;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
    last = node;
  }
  return last ? { node: last, offset: last.data.length } : { node: base, offset: base.childNodes.length };
}

/** The current DOM selection in wire form, or null when nothing shared is selected. */
export function readSelection(locate: Locator): Selection {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const start = locate(range.startContainer);
  const end = locate(range.endContainer);
  if (!start || !end || start.region !== end.region) return null;
  const startPoint: TextPoint = {
    anchor: start.anchor,
    offset: offsetWithin(textBase(start.element), range.startContainer, range.startOffset),
  };
  const endPoint: TextPoint = {
    anchor: end.anchor,
    offset: offsetWithin(textBase(end.element), range.endContainer, range.endOffset),
  };
  if (startPoint.anchor === endPoint.anchor && startPoint.offset >= endPoint.offset) return null;
  return { region: start.region, start: startPoint, end: endPoint };
}

function rangeFor(selection: NonNullable<Selection>, resolve: Resolver): Range | null {
  const startElement = resolve(selection.region, selection.start.anchor);
  const endElement = resolve(selection.region, selection.end.anchor);
  if (!startElement || !endElement) return null;
  const start = pointAt(textBase(startElement), selection.start.offset);
  const end = pointAt(textBase(endElement), selection.end.offset);
  const range = document.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return null;
  }
  return range.collapsed ? null : range;
}

type HighlightRegistry = Map<string, unknown> & { delete(name: string): boolean };
type HighlightConstructor = new (...ranges: Range[]) => unknown;

/**
 * Paints other people's selections with the CSS Custom Highlight API, which
 * styles ranges without touching the page's DOM. Browsers without it skip.
 */
export function createHighlightPainter(scope: string) {
  const registry = (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights;
  const Highlight = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight;
  const style = document.createElement("style");
  style.dataset.liveShare = scope;
  document.head.appendChild(style);
  let names: string[] = [];
  let css = "";

  return {
    paint(participants: Participant[], selfId: string, resolve: Resolver) {
      if (!registry || !Highlight) return;
      for (const name of names) registry.delete(name);
      const next: string[] = [];
      const rules: string[] = [];
      for (const participant of participants) {
        if (participant.id === selfId || !participant.selection) continue;
        const range = rangeFor(participant.selection, resolve);
        if (!range) continue;
        const name = `${scope}-${participant.id.replace(/[^A-Za-z0-9_-]/gu, "")}`;
        registry.set(name, new Highlight(range));
        next.push(name);
        rules.push(`::highlight(${name}){background-color:${participant.color}55;color:inherit}`);
      }
      names = next;
      const nextCss = rules.join("\n");
      if (nextCss !== css) {
        css = nextCss;
        style.textContent = css;
      }
    },
    dispose() {
      if (registry) for (const name of names) registry.delete(name);
      style.remove();
    },
  };
}

/** Viewport position for a cursor, or null when its target is not on screen. */
export function cursorPoint(
  participant: Participant,
  resolve: Resolver,
  viewportOf: (element: HTMLElement) => DOMRect | null,
): { x: number; y: number } | null {
  const cursor = participant.cursor;
  if (!cursor) return null;
  // A cursor on an anchor this side has not rendered (scrolled away, or a
  // collapsed row without a parent) is hidden rather than misplaced.
  let element = cursor.anchor
    ? (resolve(cursor.region, cursor.anchor) ?? (cursor.parent ? resolve(cursor.region, cursor.parent) : null))
    : resolve(cursor.region, null);
  let fx = cursor.fx;
  let fy = cursor.fy;
  if (!element && cursor.px !== null && cursor.py !== null) {
    // The anchor exists only on the other side; place it within the region.
    element = resolve(cursor.region, null);
    fx = cursor.px;
    fy = cursor.py;
  }
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const x = rect.left + fx * rect.width;
  const y = rect.top + fy * rect.height;
  const viewport = viewportOf(element);
  if (viewport && (y < viewport.top || y > viewport.bottom || x < viewport.left || x > viewport.right)) return null;
  return { x, y };
}

/** Wire cursor for a pointer over an element (or a region box when there is no anchor). */
export function cursorOver(
  event: { clientX: number; clientY: number },
  region: Region,
  element: HTMLElement,
  anchor: string | null,
  parent: string | null = null,
  regionElement: HTMLElement | null = null,
) {
  const rect = element.getBoundingClientRect();
  const box = regionElement?.getBoundingClientRect();
  return {
    region,
    anchor,
    parent,
    fx: Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(rect.width, 1))),
    fy: Math.min(3, Math.max(-2, (event.clientY - rect.top) / Math.max(rect.height, 1))),
    px: box ? Math.min(1, Math.max(0, (event.clientX - box.left) / Math.max(box.width, 1))) : null,
    py: box ? Math.min(1, Math.max(0, (event.clientY - box.top) / Math.max(box.height, 1))) : null,
  };
}

/** The nearest scrollable ancestor's box, to clip cursors to what is visible. */
export function scrollViewportOf(element: HTMLElement): DOMRect | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node.getBoundingClientRect();
  }
  return null;
}

// ---------------------------------------------------------------- follow

/** The first candidate visible at the top of a scroller, and how far it is scrolled past. */
export function readScrollPoint(
  scroller: HTMLElement,
  candidates: Iterable<HTMLElement>,
  idOf: (element: HTMLElement) => string | null,
): ScrollPoint {
  const top = scroller.getBoundingClientRect().top;
  for (const element of candidates) {
    const rect = element.getBoundingClientRect();
    if (rect.height === 0 || rect.bottom <= top) continue;
    const anchor = idOf(element);
    if (!anchor) continue;
    return { anchor, fraction: Math.max(-50, Math.min(50, (top - rect.top) / rect.height)) };
  }
  return null;
}

/** Scrolls so `element` sits at the top of `scroller`, `fraction` of the way through it. */
export function applyScrollPoint(scroller: HTMLElement, element: HTMLElement, fraction: number): void {
  const rect = element.getBoundingClientRect();
  const delta = rect.top - scroller.getBoundingClientRect().top + fraction * rect.height;
  if (Math.abs(delta) > 1) scroller.scrollTop += delta;
}

export function scrollRatio(scroller: HTMLElement): number {
  const max = scroller.scrollHeight - scroller.clientHeight;
  return max > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / max)) : 1;
}

export function isAtBottom(scroller: HTMLElement): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
}

/**
 * Calls `onIntent` when the person scrolls or clicks on their own, which ends
 * following. Programmatic scrolling fires no wheel, touch, key or pointer events.
 */
export function watchIntent(root: HTMLElement | Document, onIntent: () => void): () => void {
  const keys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
  // Only real input counts; following itself dispatches synthetic events.
  const onAny = (event: Event) => {
    if (event.isTrusted) onIntent();
  };
  const onKey = (event: Event) => {
    if (event.isTrusted && keys.has((event as KeyboardEvent).key)) onIntent();
  };
  const options = { passive: true, capture: true } as const;
  root.addEventListener("wheel", onAny, options);
  root.addEventListener("touchmove", onAny, options);
  root.addEventListener("pointerdown", onAny, options);
  root.addEventListener("keydown", onKey, options);
  return () => {
    root.removeEventListener("wheel", onAny, options);
    root.removeEventListener("touchmove", onAny, options);
    root.removeEventListener("pointerdown", onAny, options);
    root.removeEventListener("keydown", onKey, options);
  };
}
