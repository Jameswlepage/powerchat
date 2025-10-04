# PowerChat — Extensions for AI Chat (MV3)

PowerChat is a collection of lightweight tools that enhance popular AI chat interfaces like ChatGPT and Claude.

Current tool: Queue & Auto‑Send — queue multiple prompts and auto‑send them one‑by‑one whenever the page finishes “thinking.” Use the header Queue button to view/manage the queue; Enter queues from the main editor.

Use responsibly and in line with website terms. Selectors are tailored to each site’s current UI and may need updates if the site changes.

## Features
- Works on ChatGPT and Claude
- Queue multiple messages; sends next when idle (busy/idle auto‑detect)
- Header popover to add/remove/clear and pause/resume
- Enter queues from editor (Shift+Enter newline); Alt+Enter also queues
- Queue persists per tab via `chrome.storage.local`

## File Tree
```
manifest.json        # MV3 manifest
bg.js                # Background service worker (queue/state per tab)
content.js           # UI + DOM watcher + typing/sending
content.css          # Styles for panel/popover
icons.js             # Inline SVGs
```

## Install (Load Unpacked)
1. Open `chrome://extensions`
2. Toggle “Developer mode”
3. Click “Load unpacked” and select this folder (the one containing `manifest.json`)
4. Open ChatGPT (`https://chat.openai.com` or `https://chatgpt.com`) or Claude (`https://claude.ai`). A “Queue” button appears in the header.

## Usage
- Add to queue: type in the popover input and click “Add”
- Enter to queue: focus the main editor, type your message, press Enter to queue (does not send); Shift+Enter inserts a newline
- Auto‑send: when the site is idle (submit button shows “Send”/no Stop), the extension types the next queued message and sends it (clicks Send on ChatGPT; Enter fallback on Claude)
- Controls: ⏯ Pause/Resume, 🗑 Clear queue, ✕ Remove one; header “Queue” button toggles a popover

## How It Works
- Detects “thinking” by watching each site’s stop control:
  - ChatGPT: `#composer-submit-button[aria-label="Stop streaming"]` or `button[data-testid="stop-button"]`
  - Claude: `button[aria-label="Stop response"]` or page `[data-is-streaming="true"]`
- When thinking ends, `bg.js` dispatches the next queued item; `content.js` types it into the editor and submits
- Queue/state persists per tab in `chrome.storage.local`

## Customizing Selectors
If the site DOM changes, tweak the `selectors` in `content.js`. The script auto‑selects a profile for ChatGPT or Claude based on `location.hostname` and falls back to Enter to submit if a send button isn’t present.

## Hotkeys
- Enter: queue message (Shift+Enter = newline)
- Alt+Enter: also queues (handy if you customize Enter behavior)
- To change behavior, edit `hookAltEnterQueue` in `content.js`

## Troubleshooting
- Popover not visible: reload the tab and ensure the URL matches the manifest’s `matches` list
- Nothing sends: selectors may be outdated; update the constants in `content.js`
- Service worker reset: toggle the extension off/on in `chrome://extensions` and reload the page
- Permissions: the extension needs host access for `chat.openai.com` / `chatgpt.com` / `claude.ai`

## Privacy
- The queue lives in your browser storage (`chrome.storage.local`) and is scoped per tab. No data leaves your machine.

## Notes & Limits
- Sends one message at a time; waits for thinking to finish before sending next
- Does not attempt to accelerate ChatGPT; only sequences your queued prompts
- Be mindful of site rate limits and Terms of Service

## Version
- v1.0.0
