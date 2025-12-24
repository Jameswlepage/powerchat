// PowerChat Content Script Entry Point
// Injects UI, watches state, types & submits messages

import type { QueueItem } from '../shared/types';
import { safeSendMessage } from './utils';
import { initStateWatcher } from './state-watcher';
import { typeAndSend } from './editor';
import { createPopover, updateUIRoot, initHeaderObserver, updateHeaderIndicator } from './queue-ui';
import { initHotkeys, updateLocalQueueState } from './hotkeys';
import { initLinkRefFeature } from './linkref';
import { initExportFeature } from './export';

const POPOVER_ID = 'gpt-queue-popover';

// ─────────────────────────────────────────────────────────────────────────────
// Message Handling
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    msg: { type: string; queue?: QueueItem[]; paused?: boolean; text?: string; id?: string },
    _sender,
    _sendResponse
  ) => {
    if (msg.type === 'QUEUE_UPDATED') {
      const queue = msg.queue || [];
      const paused = !!msg.paused;

      // Update local state for fast-path optimization
      updateLocalQueueState(queue.length, paused);

      // Update UI
      createPopover();
      updateUIRoot(document.getElementById(POPOVER_ID), queue, paused);
      updateHeaderIndicator(queue);
    }

    if (msg.type === 'SEND_TEXT') {
      (async () => {
        try {
          await typeAndSend(msg.text!);
          // Tell background we submitted so it can shift the head item
          safeSendMessage({ type: 'SUBMITTED', id: msg.id });
        } catch (err) {
          safeSendMessage({ type: 'ERROR', error: String((err as Error)?.message || err) });
        }
      })();
    }

    return false;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

function init(): void {
  // Initialize state watcher (busy/idle detection)
  initStateWatcher();

  // Initialize UI components
  createPopover();
  initHeaderObserver();

  // Initialize keyboard shortcuts
  initHotkeys();

  // Initialize LinkRef feature after initial DOM settles
  setTimeout(() => {
    try {
      initLinkRefFeature();
    } catch {
      // ignore
    }
  }, 500);

  // Initialize export feature (ChatGPT only)
  initExportFeature();

  // Say hello so background can send us initial state
  safeSendMessage({ type: 'HELLO' });
}

// Run initialization
init();
