// Keyboard shortcut handling for queue operations

import { getEditor, getStopButton } from './site-adapter';
import { clearEditor, getEditorPlainText } from './editor';
import { safeSendMessage } from './utils';

// Track queue state locally for fast-path optimization
let localQueueEmpty = true;
let localPaused = false;

export function updateLocalQueueState(queueLength: number, paused: boolean): void {
  localQueueEmpty = queueLength === 0;
  localPaused = paused;
}

export function initHotkeys(): void {
  document.addEventListener(
    'keydown',
    async (e) => {
      // Only when focus is inside the editor
      const ed = getEditor();
      if (!ed || !ed.contains(document.activeElement)) return;

      // Alt+Enter: queue regardless of busy state
      if (e.altKey && e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const text = getEditorPlainText();
        if (text) {
          safeSendMessage({ type: 'QUEUE_ADD', text });
          clearEditor();
        }
        return;
      }

      // Plain Enter: send or queue (Shift+Enter still newline)
      if (!e.altKey && !e.metaKey && !e.ctrlKey && e.key === 'Enter' && !e.shiftKey) {
        const text = getEditorPlainText();
        if (!text) return;

        // Fast path: if queue is empty, not paused, and page is idle, let native send happen
        // This avoids the round-trip to background script and text re-injection
        const pageIdle = !getStopButton();
        if (localQueueEmpty && !localPaused && pageIdle) {
          // Don't prevent default - let the native Enter handler submit
          // The text is already in the editor, just let ChatGPT handle it
          return;
        }

        // Queue path: intercept and queue the message
        e.preventDefault();
        e.stopPropagation();
        safeSendMessage({ type: 'QUEUE_ADD', text });
        clearEditor();
      }
    },
    true
  );
}
