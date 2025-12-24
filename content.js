// content.js — injects a panel, watches "thinking", types & submits messages

////////////////////////////////////////
// 0) Utility: DOM helpers & debounce //
////////////////////////////////////////

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const debounce = (fn, ms = 100) => {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

// Safe wrapper for chrome.runtime.sendMessage to handle invalidated context
function safeSendMessage(msg, callback) {
  try {
    if (!chrome.runtime?.id) return; // Extension context invalidated
    chrome.runtime.sendMessage(msg, callback);
  } catch (e) {
    // Extension context invalidated - silently ignore
  }
}

// Visible check
const isVisible = (el) => el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

////////////////////////////////////////
// 1) Site adapters (selectors)       //
////////////////////////////////////////

const SITE = (() => {
  const h = location.hostname;
  if (h.includes('claude.ai')) return 'claude';
  return 'chatgpt';
})();

const selectors = {
  // Thinking state selectors per site (be precise for ChatGPT)
  // Note: Pro thinking mode uses different indicators (see getStopButton/isProThinking)
  stopButton: SITE === 'chatgpt'
    ? '#composer-submit-button[aria-label="Stop streaming"], button[data-testid="stop-button"]'
    : 'button[aria-label="Stop response"], [data-is-streaming="true"] button[aria-label="Stop response"]',
  // Pro thinking spinner (animated blue spinner in header during thinking)
  proThinkingSpinner: 'svg.animate-spin.text-blue-400',
  // Pro thinking Stop button (appears in bottom bar during thinking)
  proStopButton: 'div[slot="trailing"] button.btn-secondary',
  // Send button (idle) — ChatGPT uses dynamic button, Claude has labeled button
  sendButton: SITE === 'chatgpt'
    ? 'button[data-testid="send-button"], button[aria-label="Send message"], button.composer-submit-button-color[aria-label="Send message"]'
    : 'button[aria-label="Send message"]:not([disabled])',
  // Editor
  editor: SITE === 'chatgpt'
    ? '#prompt-textarea.ProseMirror[contenteditable="true"], div#prompt-textarea[contenteditable="true"]'
    : 'div[role="textbox"].ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]',
  // Fallback textarea (rare)
  fallbackTextarea: 'textarea[name="prompt-textarea"]'
};

function getStopButton() {
  // Standard stop button (non-Pro ChatGPT or Claude)
  const el = $(selectors.stopButton);
  if (el && isVisible(el)) return el;

  // ChatGPT Pro: check for thinking spinner or Pro stop button
  if (SITE === 'chatgpt') {
    // Pro thinking spinner in header
    const spinner = $(selectors.proThinkingSpinner);
    if (spinner && isVisible(spinner)) return spinner;

    // Pro stop button in bottom bar
    const proStop = $(selectors.proStopButton);
    if (proStop && isVisible(proStop)) return proStop;
  }

  return null;
}
function getSendButton() {
  const btn = $(selectors.sendButton);
  if (btn && isVisible(btn)) {
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    // If it looks like a stop button, it's not a "send" opportunity.
    if (label.includes('stop')) return null;
    return btn;
  }
  return null;
}
function getEditor() {
  let ed = $(selectors.editor);
  if (ed && isVisible(ed)) return ed;
  ed = $(selectors.fallbackTextarea);
  if (ed && isVisible(ed)) return ed;
  // Last resort: any visible contenteditable in the composer
  const candidates = $$('div[contenteditable="true"]');
  return candidates.find(isVisible) || null;
}

////////////////////////////////////////
// 2) Page-state watcher (thinking?)  //
////////////////////////////////////////

let lastBusy = undefined;
let suppressEnterOnce = false; // prevent our own synthetic Enter from re-queuing

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

const mo = new MutationObserver(reportBusy);
mo.observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['aria-label', 'data-testid', 'disabled', 'class', 'style', 'data-is-streaming']
});
window.addEventListener('load', reportBusy);
document.addEventListener('visibilitychange', reportBusy);
setTimeout(reportBusy, 500); // initial nudge

////////////////////////////////////////
// 3) Typing & sending implementation //
////////////////////////////////////////

function placeCaretAtEnd(el) {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {}
}

function setEditorText(text) {
  const ed = getEditor();
  if (!ed) throw new Error('Composer not found.');

  ed.focus();
  placeCaretAtEnd(ed);

  // Clear existing text
  try {
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, ''); // clear
  } catch {}

  // Insert new text - try execCommand first, verify with content check
  try {
    document.execCommand('insertText', false, text);
  } catch {}

  // Check if text was actually inserted before trying fallbacks
  if (getEditorPlainText()) return;

  // Fallback: try beforeinput/input events
  try {
    const before = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text });
    ed.dispatchEvent(before);
    const input = new InputEvent('input', { bubbles: true, cancelable: true, data: text });
    ed.dispatchEvent(input);
  } catch {}

  if (getEditorPlainText()) return;

  // Paste fallback for ProseMirror
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'clipboardData', { value: dt });
    ed.dispatchEvent(evt);
  } catch {}

  if (getEditorPlainText()) return;

  // Absolute fallback
  if ('value' in ed) ed.value = text; else ed.textContent = text;
  ed.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
}

function getEditorPlainText() {
  const ed = getEditor();
  if (!ed) return '';
  if ('value' in ed) return (ed.value || '').trim();

  // ProseMirror wraps content in <p> elements.
  // Preserve blank lines (empty paragraphs) to avoid losing user formatting.
  const paragraphs = ed.querySelectorAll('p');
  if (paragraphs.length > 0) {
    const lines = [];
    for (const p of paragraphs) {
      // innerText of a <p> gives us the text; strip only trailing newlines
      const pText = (p.innerText || p.textContent || '').replace(/\n+$/, '');
      // Keep empty lines (but as empty string, not whitespace)
      lines.push(pText);
    }
    // Join with single newlines; trim leading/trailing empty lines only
    let text = lines.join('\n');
    // Remove leading/trailing blank lines but preserve internal ones
    text = text.replace(/^\n+/, '').replace(/\n+$/, '');
    return text;
  }

  // Fallback for non-ProseMirror editors
  return (ed.innerText || ed.textContent || '').trim();
}

function clearEditor() {
  const ed = getEditor();
  if (!ed) return;
  try {
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, '');
  } catch {
    if ('value' in ed) ed.value = '';
    else ed.textContent = '';
  }
  ed.dispatchEvent(new InputEvent('input', { bubbles: true, data: '' }));
}

async function typeAndSend(text) {
  // Guard: only send when page not busy
  if (getStopButton()) throw new Error('Page is busy (thinking).');
  setEditorText(text);

  // Use microtask + requestAnimationFrame for minimal delay while ensuring
  // ProseMirror has processed the input. This replaces the 80ms fixed delay.
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  // Prefer clicking a visible send button when available (Claude & ChatGPT)
  let sendBtn = getSendButton();
  if (!sendBtn && SITE === 'claude') {
    // Wait briefly for button to enable after input
    const start = Date.now();
    while (Date.now() - start < 800 && !sendBtn) {
      await new Promise(r => setTimeout(r, 60));
      sendBtn = getSendButton();
    }
  }
  if (sendBtn) { sendBtn.click(); return; }

  // Fallback: simulate Enter on editor
  const ed = getEditor();
  if (!ed) throw new Error('Composer not found for Enter fallback.');
  ed.focus();
  suppressEnterOnce = true;
  const down = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true });
  const up = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true });
  ed.dispatchEvent(down);
  ed.dispatchEvent(up);
}

////////////////////////////////////////
// 4) Mini panel UI (queue controls) //
////////////////////////////////////////

const PANEL_ID = 'gpt-queue-panel';
const POPOVER_ID = 'gpt-queue-popover';
const HEADER_QUEUE_BTN_ID = 'gqp-header-queue-btn';
let lastQueueLength = 0;

function createPanel() {
  if (document.getElementById(PANEL_ID)) return;

  const root = document.createElement('div');
  root.id = PANEL_ID;
  root.innerHTML = `
    <div class="gqp-head">
      <span class="gqp-title">Queue</span>
      <div class="gqp-actions">
        <button class="gqp-btn" data-act="pause" title="Pause/Resume" aria-label="Pause/Resume"></button>
        <button class="gqp-btn" data-act="clear" title="Clear queue" aria-label="Clear queue"></button>
        <button class="gqp-btn" data-act="collapse" title="Collapse" aria-label="Collapse"></button>
      </div>
    </div>
    <div class="gqp-body">
      <div class="gqp-row">
        <input type="text" class="gqp-input" placeholder="Add message to queue…" />
        <button class="gqp-add" title="Add to queue" aria-label="Add to queue"></button>
      </div>
      <ul class="gqp-list"></ul>
      <div class="gqp-foot">
        <span class="gqp-status">idle</span>
        <span class="gqp-hint">Tip: Enter queues; Shift+Enter newline</span>
      </div>
    </div>
  `;
  document.body.appendChild(root);
  // start collapsed to keep UI minimal
  root.classList.add('gqp-collapsed');

  // inject icons
  const pauseBtn = root.querySelector('.gqp-btn[data-act="pause"]');
  const clearBtn = root.querySelector('.gqp-btn[data-act="clear"]');
  const collBtn = root.querySelector('.gqp-btn[data-act="collapse"]');
  const addBtnNode = root.querySelector('.gqp-add');
  if (pauseBtn) { const p = gqpIcon('pause'); const pl = gqpIcon('play'); pl.classList.add('ico-play'); pl.style.display = 'none'; p.classList.add('ico-pause'); pauseBtn.appendChild(p); pauseBtn.appendChild(pl); }
  if (clearBtn) clearBtn.appendChild(gqpIcon('trash'));
  if (collBtn) collBtn.appendChild(gqpIcon('chevronDown'));
  if (addBtnNode) addBtnNode.appendChild(gqpIcon('plus'));

  // Events
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    const act = btn.dataset.act;
    if (act === 'collapse') {
      root.classList.toggle('gqp-collapsed');
      return;
    }
    if (act === 'clear') {
      safeSendMessage({ type: 'QUEUE_CLEAR' });
      return;
    }
    if (act === 'pause') {
      const isPaused = root.dataset.paused === 'true';
      safeSendMessage({ type: isPaused ? 'RESUME' : 'PAUSE' });
      return;
    }
    if (btn.classList.contains('gqp-remove')) {
      const id = btn.dataset.id;
      safeSendMessage({ type: 'QUEUE_REMOVE', id });
      return;
    }
  });

  // Inline edit events (panel)
  root.addEventListener('dblclick', (e) => {
    const txt = e.target.closest('.gqp-text');
    if (txt) startInlineEdit(txt);
  });
  root.addEventListener('keydown', (e) => {
    const txt = e.target.closest('.gqp-text');
    if (!txt) return;
    if (txt.isContentEditable) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); commitInlineEdit(txt); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelInlineEdit(txt); }
    }
  }, true);
  root.addEventListener('blur', (e) => {
    const txt = e.target.closest('.gqp-text');
    if (txt && txt.isContentEditable) commitInlineEdit(txt);
  }, true);

  const addBtn = root.querySelector('.gqp-add');
  const input = root.querySelector('.gqp-input');
  addBtn.addEventListener('click', () => {
    const text = (input.value || '').trim();
    if (!text) return;
    safeSendMessage({ type: 'QUEUE_ADD', text });
    input.value = '';
    input.focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      addBtn.click();
    }
  });
}

function updatePanel(queue = [], paused = false) {
  const root = document.getElementById(PANEL_ID);
  if (!root) return;

  root.dataset.paused = String(!!paused);
  // toggle pause/play glyphs
  const pauseBtn = root.querySelector('.gqp-btn[data-act="pause"]');
  const icoPause = pauseBtn?.querySelector('.ico-pause');
  const icoPlay = pauseBtn?.querySelector('.ico-play');
  if (pauseBtn && icoPause && icoPlay) {
    if (paused) { icoPause.style.display = 'none'; icoPlay.style.display = 'block'; }
    else { icoPause.style.display = 'block'; icoPlay.style.display = 'none'; }
  }
  const list = root.querySelector('.gqp-list');
  list.innerHTML = '';
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const li = document.createElement('li');
    li.className = 'gqp-item';
    li.innerHTML = `
      <span class="gqp-num">${i + 1}</span>
      <span class="gqp-text" data-id="${item.id}" title="${item.text.replace(/\"/g, '&quot;')}">${escapeHtml(item.text)}</span>
      <button class="gqp-btn gqp-remove" data-id="${item.id}" title="Remove" aria-label="Remove">
        <svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    `;
    list.appendChild(li);
  }
  const status = root.querySelector('.gqp-status');
  status.textContent = (paused ? 'paused' : (getStopButton() ? 'thinking…' : 'idle'));
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

////////////////////////////////////////
// 5) Hotkey: Alt+Enter = queue only //
////////////////////////////////////////

// Track queue state locally for fast-path optimization
let localQueueEmpty = true;
let localPaused = false;

function hookAltEnterQueue() {
  const editRoot = document;
  editRoot.addEventListener('keydown', async (e) => {
    // Only when focus is inside the editor
    const ed = getEditor();
    if (!ed || !ed.contains(document.activeElement)) return;
    if (suppressEnterOnce && e.key === 'Enter') { suppressEnterOnce = false; return; }
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
  }, true);
}

////////////////////////////////////////
// 6) Messaging with the background   //
////////////////////////////////////////

chrome.runtime.onMessage.addListener(async (msg, _sender, sendResponse) => {
  if (msg.type === 'QUEUE_UPDATED') {
    // Update local state for fast-path optimization
    localQueueEmpty = !Array.isArray(msg.queue) || msg.queue.length === 0;
    localPaused = !!msg.paused;

    // Only use the header popover UI
    createPopover();
    createHeaderQueueButton();
    updateUIRoot(document.getElementById(POPOVER_ID), msg.queue, msg.paused);
    lastQueueLength = Array.isArray(msg.queue) ? msg.queue.length : 0;
    updateHeaderIndicator(msg.queue);
  }
  if (msg.type === 'SEND_TEXT') {
    try {
      await typeAndSend(msg.text);
      // tell background we submitted so it can shift the head item
      safeSendMessage({ type: 'SUBMITTED', id: msg.id });
    } catch (err) {
      safeSendMessage({ type: 'ERROR', error: String(err?.message || err) });
    }
  }
  return false;
});

// Say hello so background can send us initial state
safeSendMessage({ type: 'HELLO' });

// Init UI and hotkey
// Floating panel no longer used; only header popover.
createPopover();
createHeaderQueueButton();
hookAltEnterQueue();

// Keep panel status in sync with busy/idle
const syncStatus = debounce(() => {
  const root = document.getElementById(PANEL_ID);
  if (!root) return;
  const status = root.querySelector('.gqp-status');
  if (status) status.textContent = (root.dataset.paused === 'true' ? 'paused' : (getStopButton() ? 'thinking…' : 'idle'));
}, 50);
new MutationObserver(syncStatus).observe(document.documentElement, { subtree: true, childList: true, attributes: true });

// Inline composer Queue button removed; header popover is the only trigger.

////////////////////////////////////////
// 8) Header button + Popover         //
////////////////////////////////////////

function createPopover() {
  if (document.getElementById(POPOVER_ID)) return;
  const pop = document.createElement('div');
  pop.id = POPOVER_ID;
  pop.className = 'hidden';
  pop.innerHTML = `
    <div class="gqp-body">
      <div class="gqp-row">
        <input type="text" class="gqp-input" placeholder="Add message to queue…" />
        <button class="gqp-add" title="Add to queue" aria-label="Add to queue"></button>
      </div>
      <ul class="gqp-list"></ul>
      <div class="gqp-foot">
        <span class="gqp-status">idle</span>
        <div class="gqp-actions">
          <button class="gqp-btn" data-act="pause" title="Pause/Resume" aria-label="Pause/Resume"></button>
          <button class="gqp-btn" data-act="clear" title="Clear queue" aria-label="Clear queue"></button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(pop);

  // inject icons
  const addBtn = pop.querySelector('.gqp-add');
  const pauseBtn = pop.querySelector('.gqp-btn[data-act="pause"]');
  const clearBtn = pop.querySelector('.gqp-btn[data-act="clear"]');
  if (addBtn) addBtn.appendChild(gqpIcon('plus'));
  if (pauseBtn) { const p = gqpIcon('pause'); const pl = gqpIcon('play'); pl.classList.add('ico-play'); pl.style.display = 'none'; p.classList.add('ico-pause'); pauseBtn.appendChild(p); pauseBtn.appendChild(pl); }
  if (clearBtn) clearBtn.appendChild(gqpIcon('trash'));

  // events
  pop.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'clear') safeSendMessage({ type: 'QUEUE_CLEAR' });
    if (act === 'pause') {
      const isPaused = pop.dataset.paused === 'true';
      safeSendMessage({ type: isPaused ? 'RESUME' : 'PAUSE' });
    }
    if (btn.classList.contains('gqp-remove')) {
      const id = btn.dataset.id;
      safeSendMessage({ type: 'QUEUE_REMOVE', id });
    }
  });
  const inEl = pop.querySelector('.gqp-input');
  const addEl = pop.querySelector('.gqp-add');
  addEl?.addEventListener('click', () => {
    const text = (inEl.value || '').trim();
    if (!text) return;
    safeSendMessage({ type: 'QUEUE_ADD', text });
    inEl.value = '';
    inEl.focus();
  });
  inEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addEl.click(); });

  // Inline edit events (popover)
  pop.addEventListener('dblclick', (e) => {
    const txt = e.target.closest('.gqp-text');
    if (txt) startInlineEdit(txt);
  });
  pop.addEventListener('keydown', (e) => {
    const txt = e.target.closest('.gqp-text');
    if (!txt) return;
    if (txt.isContentEditable) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); commitInlineEdit(txt); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelInlineEdit(txt); }
    }
  }, true);
  pop.addEventListener('blur', (e) => {
    const txt = e.target.closest('.gqp-text');
    if (txt && txt.isContentEditable) commitInlineEdit(txt);
  }, true);
}

function updateUIRoot(root, queue = [], paused = false) {
  if (!root) return;
  root.dataset.paused = String(!!paused);
  const pauseBtn = root.querySelector('.gqp-btn[data-act="pause"]');
  const icoPause = pauseBtn?.querySelector('.ico-pause');
  const icoPlay = pauseBtn?.querySelector('.ico-play');
  if (pauseBtn && icoPause && icoPlay) {
    if (paused) { icoPause.style.display = 'none'; icoPlay.style.display = 'block'; }
    else { icoPause.style.display = 'block'; icoPlay.style.display = 'none'; }
  }
  const list = root.querySelector('.gqp-list');
  if (!list) return;
  list.innerHTML = '';
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const li = document.createElement('li');
    li.className = 'gqp-item';
    li.innerHTML = `
      <span class="gqp-num">${i + 1}</span>
      <span class="gqp-text" data-id="${item.id}" title="${item.text.replace(/\"/g, '&quot;')}">${escapeHtml(item.text)}</span>
      <button class="gqp-btn gqp-remove" data-id="${item.id}" title="Remove" aria-label="Remove"></button>
    `;
    const x = gqpIcon('x');
    li.querySelector('.gqp-remove').appendChild(x);
    list.appendChild(li);
  }
  const status = root.querySelector('.gqp-status');
  const busy = !!getStopButton();
  const state = paused ? 'paused' : (busy ? 'busy' : 'idle');
  root.dataset.state = state;
  if (status) status.textContent = (state === 'busy' ? 'thinking…' : state);
}

// Inline edit helpers
function startInlineEdit(el) {
  if (!el || el.isContentEditable) return;
  el.dataset.prev = el.textContent;
  el.contentEditable = 'true';
  el.spellcheck = true;
  el.classList.add('gqp-editing');
  el.focus();
  placeCaretAtEnd(el);
}
function commitInlineEdit(el) {
  if (!el || !el.isContentEditable) return;
  const id = el.dataset.id;
  const prev = el.dataset.prev || '';
  const text = (el.textContent || '').trim();
  el.contentEditable = 'false';
  el.classList.remove('gqp-editing');
  delete el.dataset.prev;
  if (text === prev) return;
  safeSendMessage({ type: 'QUEUE_UPDATE', id, text });
}
function cancelInlineEdit(el) {
  if (!el || !el.isContentEditable) return;
  const prev = el.dataset.prev || '';
  el.textContent = prev;
  el.contentEditable = 'false';
  el.classList.remove('gqp-editing');
  delete el.dataset.prev;
}

function updateAllUIs(queue, paused) {
  updateUIRoot(document.getElementById(PANEL_ID), queue, paused);
  updateUIRoot(document.getElementById(POPOVER_ID), queue, paused);
}

function positionPopover(btn) {
  const pop = document.getElementById(POPOVER_ID);
  if (!pop || !btn) return;
  const r = btn.getBoundingClientRect();
  const margin = 8;
  const top = r.bottom + margin + window.scrollY;
  let left = r.left + window.scrollX;
  const maxLeft = (window.scrollX + document.documentElement.clientWidth) - pop.offsetWidth - 12;
  if (left > maxLeft) left = Math.max(12, maxLeft);
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
}

function createHeaderQueueButton() {
  if (document.getElementById(HEADER_QUEUE_BTN_ID)) return;
  const header = document.querySelector('header#page-header, header[data-testid="page-header"], header');
  if (!header) return;

  // ChatGPT layout: prefer the centered header actions container
  if (SITE === 'chatgpt') {
    const centerContainer =
      header.querySelector('#conversation-header-actions')?.closest('.flex.items-center.justify-center.gap-3') ||
      header.querySelector('.flex.items-center.justify-center.gap-3');
    if (centerContainer) {
      const btn = document.createElement('button');
      btn.id = HEADER_QUEUE_BTN_ID;
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Open queue');
      btn.title = 'Open queue';
      btn.appendChild(gqpIcon('queue', { size: 18 }));
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = 'Queue';
      btn.appendChild(label);

      const anchor = centerContainer.querySelector('.flex-shrink-0');
      if (anchor && anchor.nextSibling) {
        centerContainer.insertBefore(btn, anchor.nextSibling);
      } else {
        centerContainer.appendChild(btn);
      }

      let outsideHandler = null;
      btn.addEventListener('click', () => {
        createPopover();
        const pop = document.getElementById(POPOVER_ID);
        if (!pop) return;
        const isHidden = pop.classList.contains('hidden');
        if (isHidden) {
          pop.classList.remove('hidden');
          pop.style.visibility = 'hidden';
          requestAnimationFrame(() => {
            pop.style.visibility = '';
            positionPopover(btn);
          });
          outsideHandler = (e) => {
            if (!pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
              pop.classList.add('hidden');
              document.removeEventListener('mousedown', outsideHandler);
              outsideHandler = null;
            }
          };
          document.addEventListener('mousedown', outsideHandler);
        } else {
          pop.classList.add('hidden');
          if (outsideHandler) {
            document.removeEventListener('mousedown', outsideHandler);
            outsideHandler = null;
          }
        }
      });

      window.addEventListener('resize', () => positionPopover(btn));
      window.addEventListener('scroll', () => positionPopover(btn), true);
      updateHeaderIndicatorCount(lastQueueLength);
      return;
    }
  }

  // Generic ChatGPT / Claude actions area (fallback)
  let shareBtn = header.querySelector('#conversation-header-actions [data-testid="share-chat-button"]');
  // Claude header containers
  let claudeActions = null; // absolutely positioned actions cluster
  let rightGroup = null;    // inline right cluster fallback
  if (!shareBtn) {
    claudeActions = document.querySelector('[data-testid="wiggle-controls-actions"]');
    rightGroup = header.querySelector('.right-3.flex.gap-2, .right-3');
  }

  const btn = document.createElement('button');
  btn.id = HEADER_QUEUE_BTN_ID;
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Open queue');
  btn.title = 'Open queue';
  btn.appendChild(gqpIcon('queue', { size: 18 }));
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Queue';
  btn.appendChild(label);

  if (shareBtn) {
    // Insert inside the actions container, directly to the left of Share
    const actions = shareBtn.closest('#conversation-header-actions') || shareBtn.parentElement;
    if (actions) actions.insertBefore(btn, shareBtn);
    else shareBtn.insertAdjacentElement('beforebegin', btn);
  } else if (claudeActions) {
    // Claude: Prefer the absolute actions cluster
    const claudeShare = claudeActions.querySelector('[data-testid="wiggle-controls-actions-share"]');
    if (claudeShare) claudeShare.insertAdjacentElement('beforebegin', btn);
    else claudeActions.insertAdjacentElement('afterbegin', btn);
    // Keep ordering if Share mounts later
    const reorder = new MutationObserver(() => {
      const q = document.getElementById(HEADER_QUEUE_BTN_ID);
      const sh = claudeActions.querySelector('[data-testid="wiggle-controls-actions-share"]');
      if (q && sh && q.nextElementSibling !== sh) {
        sh.insertAdjacentElement('beforebegin', q);
      }
    });
    reorder.observe(claudeActions, { childList: true, subtree: false });
  } else if (rightGroup) {
    // Fallback to inline right group if absolute actions not present
    rightGroup.insertAdjacentElement('afterbegin', btn);
  } else {
    // Fallback: append to header's right side wrapper
    const wrapper = header.querySelector('.flex.w-full.items-center.justify-between');
    (wrapper || header).appendChild(btn);
  }

  let outsideHandler = null;
  btn.addEventListener('click', () => {
    createPopover();
    const pop = document.getElementById(POPOVER_ID);
    if (!pop) return;
    const isHidden = pop.classList.contains('hidden');
    if (isHidden) {
      pop.classList.remove('hidden');
      // ensure size before positioning
      pop.style.visibility = 'hidden';
      requestAnimationFrame(() => {
        pop.style.visibility = '';
        positionPopover(btn);
      });
      // outside click to close
      outsideHandler = (e) => {
        if (!pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
          pop.classList.add('hidden');
          document.removeEventListener('mousedown', outsideHandler);
          outsideHandler = null;
        }
      };
      document.addEventListener('mousedown', outsideHandler);
    } else {
      pop.classList.add('hidden');
      if (outsideHandler) {
        document.removeEventListener('mousedown', outsideHandler);
        outsideHandler = null;
      }
    }
  });

  window.addEventListener('resize', () => positionPopover(btn));
  window.addEventListener('scroll', () => positionPopover(btn), true);

  // Set initial indicator state
  updateHeaderIndicatorCount(lastQueueLength);
}

// Observe header to (re)attach the button if DOM rerenders
const headerObs = new MutationObserver(debounce(() => {
  createHeaderQueueButton();
}, 100));
headerObs.observe(document.documentElement, { subtree: true, childList: true });
createHeaderQueueButton();

function updateHeaderIndicator(queue = []) {
  updateHeaderIndicatorCount(Array.isArray(queue) ? queue.length : 0);
}

function updateHeaderIndicatorCount(n = 0) {
  const btn = document.getElementById(HEADER_QUEUE_BTN_ID);
  if (!btn) return;
  btn.dataset.hasItems = String(n > 0);
}

////////////////////////////////////////
// 9) PowerChat: LinkRef scaffold     //
////////////////////////////////////////

function initLinkRefFeature() {
  const ed = getEditor();
  if (!ed) return;

  const URL_RE = /@https?:\/\/\S+$/;

  function hostFrom(u) {
    try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; }
  }

  function createToken(url) {
    const span = document.createElement('span');
    span.className = 'pc-ref';
    span.contentEditable = 'false';
    span.dataset.url = url;
    span.title = url;
    span.innerHTML = `<span class="pc-ref-badge">@</span><span class="pc-ref-host">${escapeHtml(hostFrom(url))}</span>`;
    // Fetch markdown asynchronously via background (scaffold)
    safeSendMessage({ type: 'LINKREF_FETCH_MD', url }, (res) => {
      if (res?.ok && typeof res.md === 'string') {
        span.dataset.md = res.md;
      }
    });
    return span;
  }

  function replaceTypedUrlWithToken() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    let node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent || '';
    const uptoCaret = text.slice(0, range.startOffset);
    const m = uptoCaret.match(URL_RE);
    if (!m) return;
    const match = m[0];
    const url = match.slice(1); // drop leading '@'
    const start = range.startOffset - match.length;
    const r = document.createRange();
    r.setStart(node, start);
    r.setEnd(node, range.startOffset);
    r.deleteContents();
    const token = createToken(url);
    r.insertNode(token);
    // Add trailing space for separation
    token.insertAdjacentText('afterend', ' ');
    // Move caret after the token + space
    sel.removeAllRanges();
    const after = document.createRange();
    after.setStartAfter(token.nextSibling || token);
    after.collapse(true);
    sel.addRange(after);
  }

  ed.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter' || e.key === ',') {
      replaceTypedUrlWithToken();
    }
  });

  function expandTokensForSend() {
    const editor = getEditor();
    if (!editor) return;
    const tokens = editor.querySelectorAll('.pc-ref');
    tokens.forEach(tok => {
      const url = tok.dataset.url || '';
      const md = tok.dataset.md || `Referenced URL: ${url}`;
      const textNode = document.createTextNode(md);
      tok.replaceWith(textNode);
    });
  }

  // Hook send button click to expand tokens just before submission
  const sendBtn = getSendButton();
  if (sendBtn) {
    sendBtn.addEventListener('mousedown', expandTokensForSend, true);
    sendBtn.addEventListener('click', expandTokensForSend, true);
  }
  // Cmd/Ctrl+Enter shortcut
  document.addEventListener('keydown', (e) => {
    const isMac = navigator.platform.includes('Mac');
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && e.key === 'Enter') expandTokensForSend();
  }, true);
}

// Initialize LinkRef after initial DOM settles
setTimeout(() => { try { initLinkRefFeature(); } catch {} }, 500);

////////////////////////////////////////
// 10) Chat history / header: MD export //
////////////////////////////////////////

// Add "Copy as Markdown" / "Download as Markdown" to:
// - the left sidebar history item menu, and
// - the main conversation header overflow menu (when on /c/:id).

if (SITE === 'chatgpt') {
  initHistoryMarkdownMenuEnhancer();
}

function initHistoryMarkdownMenuEnhancer() {
  // 1) Hook directly off Radix trigger clicks (header + history 3-dots).
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest(
      'button[data-testid="conversation-options-button"], button[data-testid^="history-item-"][data-testid$="-options"]'
    );
    if (!btn) return;

    // Radix wraps the button in a div that gets used for aria-labelledby.
    const wrapper = btn.parentElement && /^radix-/.test(btn.parentElement.id) ? btn.parentElement : btn;
    const labelId = wrapper.id || btn.id;
    if (!labelId) return;

    // Allow Radix to mount/update the popover first.
    setTimeout(() => {
      const menu = document.querySelector(
        `div[role="menu"][data-radix-menu-content][aria-labelledby="${labelId}"]`
      );
      if (menu) tryEnhanceMarkdownMenu(menu);
    }, 0);
  }, true);

  // 2) Fallback: in case menus are already mounted when we load.
  document
    .querySelectorAll('div[role="menu"][data-radix-menu-content]')
    .forEach((el) => tryEnhanceMarkdownMenu(el));
}

function tryEnhanceMarkdownMenu(menuEl) {
  if (!menuEl || menuEl.dataset.gqpMdMenu === 'true') return;

  const labelId = menuEl.getAttribute('aria-labelledby');
  if (!labelId) return;
  const trigger = document.getElementById(labelId);
  if (!trigger) return;

  const testId = trigger.getAttribute('data-testid') || '';
  const isSidebarHistory = /^history-item-\d+-options$/.test(testId);
  const isHeaderMenu = !!trigger.closest('header#page-header, header[data-testid="page-header"]');
  let conversationId = null;
  let downloadTitleSourceEl = null;

  // Case 1: sidebar history item menu
  if (isSidebarHistory) {
    const anchor = trigger.closest('a[href*="/c/"]');
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    const m = href.match(/\/c\/([0-9a-f-]+)/i);
    if (!m) return;
    conversationId = m[1];
    downloadTitleSourceEl = anchor;
  } else {
    // Case 2: header overflow menu on a /c/:id page
    const pathMatch = location.pathname.match(/^\/c\/([0-9a-f-]+)/i);
    if (!isHeaderMenu || !pathMatch) return;
    conversationId = pathMatch[1];
    // Header title lives somewhere else; we'll fall back to conversation ID if we can't find it.
    downloadTitleSourceEl = document.querySelector('h1, [data-testid="conversation-title"]') || null;
  }
  if (!conversationId) return;

  // Ensure it's the expected chat menu (must have a delete item; sidebar also has share item).
  const deleteItem = menuEl.querySelector('[data-testid="delete-chat-menu-item"]');
  if (!deleteItem) return;
  if (isSidebarHistory) {
    const shareItem = menuEl.querySelector('[data-testid="share-chat-menu-item"]');
    if (!shareItem) return;
  }

  menuEl.dataset.gqpMdMenu = 'true';

  const copyItem = buildHistoryMenuItem('Copy as Markdown', 'copy', 'gqp-copy-md-menu-item');
  const downloadItem = buildHistoryMenuItem('Download as Markdown', 'download', 'gqp-download-md-menu-item');

  // Insert just above "Delete".
  deleteItem.parentNode.insertBefore(downloadItem, deleteItem);
  deleteItem.parentNode.insertBefore(copyItem, downloadItem);

  copyItem.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Close the menu first
    const menu = e.target.closest('[role="menu"]');
    if (menu) menu.style.display = 'none';
    try {
      console.log('[PowerChat] Fetching conversation:', conversationId);
      const md = await fetchConversationMarkdown(conversationId);
      if (!md) return;
      await navigator.clipboard.writeText(md);
      console.log('[PowerChat] Copied to clipboard successfully');
    } catch (err) {
      console.error('[PowerChat] Copy as Markdown failed:', err);
      alert('Could not copy conversation as Markdown.');
    }
  });

  downloadItem.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Close the menu first
    const menu = e.target.closest('[role="menu"]');
    if (menu) menu.style.display = 'none';
    try {
      console.log('[PowerChat] Fetching conversation for download:', conversationId);
      const md = await fetchConversationMarkdown(conversationId);
      if (!md) return;
      const title = getConversationTitleForDownload(downloadTitleSourceEl) || conversationId;
      downloadMarkdownFile(md, title);
      console.log('[PowerChat] Downloaded successfully');
    } catch (err) {
      console.error('[PowerChat] Download as Markdown failed:', err);
      alert('Could not download conversation as Markdown.');
    }
  });
}

function buildHistoryMenuItem(labelText, iconKind, testId) {
  const item = document.createElement('div');
  item.setAttribute('role', 'menuitem');
  item.tabIndex = 0;
  item.className = 'group __menu-item gap-1.5';
  item.dataset.orientation = 'vertical';
  item.dataset.radixCollectionItem = '';
  if (testId) item.dataset.testid = testId;

  const iconWrap = document.createElement('div');
  iconWrap.className = 'flex items-center justify-center group-disabled:opacity-50 group-data-disabled:opacity-50 icon';
  iconWrap.innerHTML = iconKind === 'download'
    ? `<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
         <path d="M10.0002 2.66797C10.3674 2.66797 10.6652 2.96573 10.6652 3.33297V10.3903L12.6274 8.42814C12.888 8.1675 13.3091 8.1675 13.5688 8.42814C13.8284 8.68784 13.8284 9.10897 13.5688 9.36861L10.4705 12.4669C10.211 12.7264 9.78898 12.7264 9.52928 12.4669L6.43103 9.36861C6.17134 9.10897 6.17134 8.68784 6.43103 8.42814C6.69063 8.1675 7.1117 8.1675 7.37234 8.42814L9.33452 10.3903V3.33297C9.33452 2.96573 9.63229 2.66797 9.99952 2.66797H10.0002Z"></path>
         <path d="M4.16699 12.5C3.79977 12.5 3.50199 12.7978 3.50199 13.165V14.166C3.50199 15.5477 4.62031 16.666 6.00199 16.666H13.9987C15.3804 16.666 16.4987 15.5477 16.4987 14.166V13.165C16.4987 12.7978 16.201 12.5 15.8337 12.5C15.4665 12.5 15.1687 12.7978 15.1687 13.165V14.166C15.1687 14.8153 14.6481 15.336 13.9987 15.336H6.00199C5.35265 15.336 4.83199 14.8153 4.83199 14.166V13.165C4.83199 12.7978 4.53423 12.5 4.16699 12.5Z"></path>
       </svg>`
    : `<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
         <path d="M6.66699 3.33301C5.93002 3.33301 5.3128 3.33312 4.8259 3.37161C4.33102 3.4107 3.92903 3.49218 3.5787 3.66738C3.0623 3.92683 2.63982 4.34931 2.38037 4.86571C2.20516 5.21605 2.12368 5.61803 2.08459 6.11291C2.0461 6.59981 2.046 7.21703 2.046 7.95401V12.046C2.046 12.783 2.0461 13.4003 2.08459 13.8872C2.12368 14.382 2.20516 14.784 2.38037 15.1343C2.63982 15.6507 3.0623 16.0732 3.5787 16.3326C3.92903 16.5078 4.33102 16.5893 4.8259 16.6284C5.3128 16.6669 5.93002 16.667 6.66699 16.667H13.3337C14.0706 16.667 14.6879 16.6669 15.1748 16.6284C15.6697 16.5893 16.0717 16.5078 16.422 16.3326C16.9384 16.0732 17.3609 15.6507 17.6204 15.1343C17.7956 14.784 17.877 14.382 17.9161 13.8872C17.9546 13.4003 17.9547 12.783 17.9547 12.046V7.95401C17.9547 7.21704 17.9546 6.59981 17.9161 6.11291C17.877 5.61803 17.7956 5.21604 17.6204 4.86571C17.3609 4.34931 16.9384 3.92683 16.422 3.66738C16.0717 3.49217 15.6697 3.4107 15.1748 3.37161C14.6879 3.33312 14.0706 3.33301 13.3337 3.33301H6.66699Z"></path>
         <path d="M7.5 5.83301C7.13181 5.83301 6.83333 6.13149 6.83333 6.49967C6.83333 6.86786 7.13181 7.16634 7.5 7.16634H12.5C12.8682 7.16634 13.1667 6.86786 13.1667 6.49967C13.1667 6.13149 12.8682 5.83301 12.5 5.83301H7.5Z" fill="#111827"></path>
       </svg>`;

  const label = document.createElement('div');
  label.textContent = labelText;

  item.appendChild(iconWrap);
  item.appendChild(label);
  return item;
}

const conversationMarkdownCache = new Map();

// Extract oai-device-id from cookies or localStorage
function getOaiDeviceId() {
  // Try localStorage first (ChatGPT stores device ID here)
  try {
    const stored = localStorage.getItem('oai-did');
    if (stored) return stored;
  } catch {}

  // Try parsing from cookies
  try {
    const match = document.cookie.match(/oai-did=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  } catch {}

  // Try extracting from page state
  try {
    const ctx = window.__reactRouterContext;
    const deviceId = ctx?.state?.oaiDeviceId || ctx?.clientBootstrap?.deviceId;
    if (deviceId) return deviceId;
  } catch {}

  return null;
}

// Extract oai-client-version from script tags or global state
function getOaiClientVersion() {
  try {
    // ChatGPT often embeds version in __NEXT_DATA__ or script content
    const nextData = document.getElementById('__NEXT_DATA__');
    if (nextData) {
      const data = JSON.parse(nextData.textContent);
      if (data?.buildId) return `prod-${data.buildId}`;
    }
  } catch {}

  try {
    const ctx = window.__reactRouterContext;
    if (ctx?.clientBootstrap?.version) return ctx.clientBootstrap.version;
  } catch {}

  return null;
}

async function fetchConversationMarkdown(conversationId) {
  if (!conversationId) return '';
  if (conversationMarkdownCache.has(conversationId)) {
    return conversationMarkdownCache.get(conversationId);
  }

  // Try to reuse the app's access token when available.
  let auth = '';
  try {
    const ctx = window.__reactRouterContext;
    const token = ctx?.clientBootstrap?.session?.account?.accessToken;
    if (typeof token === 'string' && token) {
      auth = `Bearer ${token}`;
    }
  } catch {}

  try {
    const headers = {
      'accept': '*/*',
      'oai-language': navigator.language || 'en-US'
    };

    // Add device ID header if available (required by ChatGPT API)
    const deviceId = getOaiDeviceId();
    if (deviceId) {
      headers['oai-device-id'] = deviceId;
    }

    // Add client version if available
    const clientVersion = getOaiClientVersion();
    if (clientVersion) {
      headers['oai-client-version'] = clientVersion;
    }

    if (auth) {
      headers['authorization'] = auth;
    }

    console.log('[PowerChat] Fetching with headers:', {
      deviceId: deviceId ? 'present' : 'missing',
      clientVersion: clientVersion ? 'present' : 'missing',
      auth: auth ? 'present' : 'missing',
      language: headers['oai-language']
    });

    const res = await fetch(`/backend-api/conversation/${conversationId}`, {
      method: 'GET',
      credentials: 'include',
      headers
    });

    console.log('[PowerChat] API response status:', res.status);

    if (!res.ok) {
      if (res.status === 404) {
        throw new Error('Conversation not found. It may have been deleted or is inaccessible.');
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error('Authentication failed. Please refresh the page and try again.');
      }
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    const md = conversationToMarkdown(data);
    conversationMarkdownCache.set(conversationId, md);
    return md;
  } catch (err) {
    console.error('[PowerChat] Failed to fetch conversation JSON:', err);
    alert(err.message || 'Could not load conversation from server.');
    return '';
  }
}

function conversationToMarkdown(conv) {
  if (!conv) return '';
  const title = conv.title || 'ChatGPT Conversation';
  const mapping = conv.mapping || {};

  // Find root node (no parent or parent is null/missing from mapping)
  let rootId = Object.keys(mapping).find((id) => {
    const n = mapping[id];
    return n && (!n.parent || !mapping[n.parent]);
  });

  if (!rootId) return `# ${title}\n\n(Empty conversation)\n`;

  // Traverse forward via children (DFS, following first child to get main thread)
  const messages = [];
  const seen = new Set();
  const stack = [rootId];

  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);

    const node = mapping[nodeId];
    if (!node) continue;

    // Collect message if visible
    if (node.message) {
      const meta = node.message.metadata || {};
      // Skip hidden system messages
      if (!meta.is_visually_hidden_from_conversation) {
        messages.push(node.message);
      }
    }

    // Follow children (push in reverse to process first child first)
    const children = node.children || [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }

  let out = `# ${title}\n\n`;
  for (const msg of messages) {
    const role = (msg.author && msg.author.role) || 'assistant';
    // Skip system role in output
    if (role === 'system') continue;
    const headerRole = role.charAt(0).toUpperCase() + role.slice(1);
    const body = renderMessageContentToMarkdown(msg);
    if (!body.trim()) continue;
    out += `## ${headerRole}\n\n${body.trim()}\n\n`;
  }
  return out.trim() + '\n';
}

function renderMessageContentToMarkdown(message) {
  const c = message && message.content;
  if (!c) return '';

  const contentType = c.content_type;

  // Handle different content types
  switch (contentType) {
    case 'thoughts': {
      // Pro thinking content - render as collapsible details
      const thoughts = c.thoughts || [];
      if (!thoughts.length) return '';
      const thoughtsText = thoughts
        .map(t => {
          const summary = t.summary || 'Thinking';
          const content = t.content || '';
          return `**${summary}**\n${content}`;
        })
        .join('\n\n');
      return `<details>\n<summary>💭 Thinking</summary>\n\n${thoughtsText}\n</details>`;
    }

    case 'reasoning_recap': {
      // Thinking duration summary (e.g., "Thought for 1m 20s")
      const recap = c.content || '';
      return recap ? `*${recap}*` : '';
    }

    case 'code': {
      // Code execution - try to extract code and result
      const code = c.code || c.text || '';
      const result = c.result || '';
      let out = '';
      if (code) out += '```\n' + code + '\n```';
      if (result) out += '\n\n**Result:**\n```\n' + result + '\n```';
      return out;
    }

    case 'model_editable_context': {
      // Memory updates - skip or render minimally
      return '';
    }

    case 'text':
    default: {
      // Standard text content with parts array
      const parts = Array.isArray(c.parts) ? c.parts : (typeof c.text === 'string' ? [c.text] : []);
      if (!parts.length && typeof c === 'string') return c;

      return parts
        .map((part) => {
          if (!part) return '';
          if (typeof part === 'string') return part;
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
          if (part.type === 'image_file' || part.type === 'image' || part.type === 'image_asset_pointer') {
            const alt = part.alt || (part.metadata && part.metadata.alt) || 'image';
            return `![${alt}](image)`;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n\n');
    }
  }
}

async function copyTextToClipboard(text) {
  if (!text) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {}
  // Fallback: hidden textarea + execCommand.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(ta);
  }
}

function downloadMarkdownFile(md, name) {
  if (!md) return;
  const base = (name || 'conversation')
    .replace(/[^a-z0-9\-_\s]+/gi, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'conversation';
  const filename = `${base}.md`;
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

function getConversationTitleForDownload(anchorEl) {
  if (!anchorEl) return '';
  const titleEl = anchorEl.querySelector('[title]') || anchorEl.querySelector('span[dir="auto"]');
  const title = (titleEl && (titleEl.getAttribute('title') || titleEl.textContent)) || '';
  return title.trim();
}
