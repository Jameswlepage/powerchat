// DOM helpers and utility functions

export const $ = <T extends Element = Element>(
  sel: string,
  root: Document | Element = document
): T | null => root.querySelector<T>(sel);

export const $$ = <T extends Element = Element>(
  sel: string,
  root: Document | Element = document
): T[] => Array.from(root.querySelectorAll<T>(sel));

export const debounce = <T extends (...args: unknown[]) => void>(
  fn: T,
  ms = 100
): ((...args: Parameters<T>) => void) => {
  let t: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

export const isVisible = (el: Element | null): boolean =>
  !!el && !!(el.getBoundingClientRect().width || el.getBoundingClientRect().height || el.getClientRects().length);

export function escapeHtml(s: string): string {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function placeCaretAtEnd(el: HTMLElement): void {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch {
    // ignore
  }
}

// Safe wrapper for chrome.runtime.sendMessage to handle invalidated context
export function safeSendMessage(
  msg: unknown,
  callback?: (response: unknown) => void
): void {
  try {
    if (!chrome.runtime?.id) return; // Extension context invalidated
    if (callback) {
      chrome.runtime.sendMessage(msg, callback);
    } else {
      chrome.runtime.sendMessage(msg);
    }
  } catch {
    // Extension context invalidated - silently ignore
  }
}
