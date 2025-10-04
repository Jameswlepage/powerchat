# ChatGPT Queue & Auto‑Send (MV3)

Queue multiple prompts on the ChatGPT web UI and auto‑send them one‑by‑one whenever the page finishes “thinking.” Includes a tiny floating panel to view/manage the queue and a hotkey to queue without sending.

> Use responsibly and in line with website terms. Selectors are tailored to ChatGPT’s current composer and may need updates if the site changes.

## Features
- Queue multiple messages; sends next when ChatGPT is idle
- Floating panel to add/remove/clear and pause/resume
- Hotkey: Alt+Enter (Option+Enter on Mac) queues from the main editor
- One‑at‑a‑time sending with busy/idle detection (watches the Stop button)
- Queue persists per tab via `chrome.storage.local`

## File Tree
```
chatgpt-queue-extension/
├─ manifest.json        # MV3 manifest
├─ bg.js                # Background service worker (queue/state per tab)
├─ content.js           # Panel UI + DOM watcher + typing/sending
├─ content.css          # Panel styles
```

## Install (Load Unpacked)
1. Open `chrome://extensions`
2. Toggle “Developer mode”
3. Click “Load unpacked” and select the `chatgpt-queue-extension` folder
4. Open ChatGPT (`https://chat.openai.com` or `https://chatgpt.com`). The “Queue” panel appears in the bottom‑right

## Usage
- Add to queue: type in the panel or popover input and click “Add”
- Enter to queue: focus the main editor, type your message, press Enter to queue (does not send); Shift+Enter inserts a newline
- Auto‑send: when the site is idle (no Stop button), the extension types the next queued message and clicks Send
- Controls: ⏯ Pause/Resume, 🗑 Clear queue, ✕ Remove one, ▾ Collapse panel; header “Queue” button toggles a popover next to Share

## How It Works
- `content.js` observes the DOM to detect “thinking” by watching the Stop button (`data-testid="stop-button"` or `aria-label*="Stop streaming"`).
- When thinking ends, `bg.js` dispatches the next queued item; `content.js` types it into the editor and clicks Send.
- Queue/state persists per tab in `chrome.storage.local`.

## Customizing Selectors
If ChatGPT’s DOM changes, tweak the selector constants in `content.js`:

```js
// chatgpt-queue-extension/content.js
const selectors = {
  stopButton: 'button[data-testid="stop-button"], button[aria-label*="Stop streaming"]',
  sendButton:  '#composer-submit-button',
  editor:      '#prompt-textarea.ProseMirror[contenteditable="true"], div#prompt-textarea[contenteditable="true"]',
  fallbackTextarea: 'textarea[name="prompt-textarea"]'
};
```

Tips:
- Thinking: update `stopButton` if the Stop control changes
- Ready/Send: point `sendButton` to the visible send control when idle
- Editor: adjust `editor`/`fallbackTextarea` if the composer changes

## Hotkeys
- Enter: queue message (Shift+Enter = newline)
- Alt+Enter: also queues (handy if you customize Enter behavior)
  - To change behavior, edit `hookAltEnterQueue` in `content.js`

## Troubleshooting
- Panel not visible: reload the tab and ensure the URL matches the manifest’s `matches` list
- Nothing sends: selectors may be outdated; update the constants in `content.js`
- Service worker reset: toggle the extension off/on in `chrome://extensions` and reload the page
- Permissions: the extension needs host access for `chat.openai.com` / `chatgpt.com`

## Privacy
- The queue lives in your browser storage (`chrome.storage.local`) and is scoped per tab. No data leaves your machine.

## Notes & Limits
- Sends one message at a time; waits for thinking to finish before sending next
- Does not attempt to accelerate ChatGPT; only sequences your queued prompts
- Be mindful of site rate limits and Terms of Service

## Version
- v1.0.0
