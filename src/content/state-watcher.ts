// Page state watcher: detects busy/idle state via MutationObserver

import { SITE, getStopButton } from './site-adapter';
import { debounce, safeSendMessage } from './utils';

let lastBusy: boolean | undefined = undefined;

const reportBusy = debounce(() => {
  // ChatGPT: detect stop button OR Pro thinking indicators (spinner, trailing stop btn).
  // Claude: also honor a page-level streaming flag when present.
  const streamingEl = SITE === 'claude' ? document.querySelector('[data-is-streaming="true"]') : null;
  const busy = !!getStopButton() || !!streamingEl;

  if (busy !== lastBusy) {
    lastBusy = busy;
    safeSendMessage({ type: 'PAGE_STATE', busy });
  }
}, 50);

export function initStateWatcher(): void {
  const mo = new MutationObserver(reportBusy);
  mo.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-label', 'data-testid', 'disabled', 'class', 'style', 'data-is-streaming'],
  });

  window.addEventListener('load', reportBusy);
  document.addEventListener('visibilitychange', reportBusy);

  // Initial nudge
  setTimeout(reportBusy, 500);
}

export function isBusy(): boolean {
  return !!getStopButton();
}
