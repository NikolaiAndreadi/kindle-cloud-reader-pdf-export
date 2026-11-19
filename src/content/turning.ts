// Dispatched key events carry isTrusted: false and a content script cannot
// forge that, so a reader that checks it will ignore them however they are
// aimed. Rather than guess, the scan tries several approaches and keeps
// whichever one actually moves the reader.

import { nextPageControl, RENDERER_SELECTOR } from './dom.ts';

export interface TurnStrategy {
  name: string;
  run: () => void;
}

function sendArrowRight(target: EventTarget): void {
  for (const type of ['keydown', 'keypress', 'keyup']) {
    target.dispatchEvent(new KeyboardEvent(type, {
      key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39,
      bubbles: true, cancelable: true, composed: true, view: window
    } as KeyboardEventInit));
  }
}

/**
 * Exactly the sequence a real click produces, and no more. Dispatching 'click'
 * *and* calling element.click() fires two clicks, which turns two pages per
 * attempt and silently drops every other page.
 */
function dispatchClick(target: EventTarget, clientX: number, clientY: number): void {
  const base: MouseEventInit = {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX, clientY, button: 0
  };
  target.dispatchEvent(new PointerEvent('pointerdown', base));
  target.dispatchEvent(new MouseEvent('mousedown', base));
  target.dispatchEvent(new PointerEvent('pointerup', base));
  target.dispatchEvent(new MouseEvent('mouseup', base));
  target.dispatchEvent(new MouseEvent('click', base));
}

function clickCentre(element: Element): void {
  const rect = element.getBoundingClientRect();
  dispatchClick(element, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function clickRightEdge(): void {
  const rect = document.querySelector(RENDERER_SELECTOR)?.getBoundingClientRect();
  if (!rect?.width) return;
  const x = rect.right - Math.max(8, rect.width * .08);
  const y = rect.top + rect.height / 2;
  const target = document.elementFromPoint(x, y);
  if (target) dispatchClick(target, x, y);
}

export const TURN_STRATEGIES: TurnStrategy[] = [
  {
    name: 'next-button',
    run: () => {
      const control = nextPageControl();
      if (control) clickCentre(control);
    }
  },
  { name: 'keys-document', run: () => sendArrowRight(document) },
  { name: 'keys-window', run: () => sendArrowRight(window) },
  {
    name: 'keys-renderer',
    run: () => {
      const renderer = document.querySelector<HTMLElement>(RENDERER_SELECTOR);
      renderer?.focus?.();
      sendArrowRight(renderer || document);
    }
  },
  { name: 'keys-body', run: () => sendArrowRight(document.body) },
  { name: 'click-right-edge', run: clickRightEdge }
];

/**
 * Probes the strategies in order until one moves the reader, then sticks with
 * it. Movement is reported by the caller, which is the only place that knows
 * whether the rendered pixels actually changed.
 */
export function turnProber(remembered: string | null) {
  let chosen = TURN_STRATEGIES.findIndex((strategy) => strategy.name === remembered);
  let probing = chosen < 0;
  let nextProbe = 0;
  // Which strategy ran at the end of the previous iteration, so movement can be
  // credited to it. -1 until the first turn is attempted: the first capture
  // always looks like movement and must not be credited to anything.
  let lastAttempt = -1;

  return {
    get probing(): boolean {
      return probing;
    },
    /** How many stalled iterations to tolerate before giving up. */
    stallBudget(settled: number): number {
      // While probing, allow one stalled iteration per strategy: otherwise the
      // scan gives up before the later strategies have been tried at all.
      return probing ? TURN_STRATEGIES.length + 1 : settled;
    },
    /** The strategy that just proved itself, or null if nothing is settled yet. */
    settle(): string | null {
      if (!probing || lastAttempt < 0) return null;
      chosen = lastAttempt;
      probing = false;
      return TURN_STRATEGIES[chosen]!.name;
    },
    /** Turn the page. Returns the strategy tried, or null when all are spent. */
    turn(): string | null {
      if (!probing) {
        TURN_STRATEGIES[chosen]!.run();
        return TURN_STRATEGIES[chosen]!.name;
      }
      if (nextProbe >= TURN_STRATEGIES.length) return null;
      lastAttempt = nextProbe;
      nextProbe += 1;
      TURN_STRATEGIES[lastAttempt]!.run();
      return TURN_STRATEGIES[lastAttempt]!.name;
    }
  };
}
