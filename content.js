// content.js — injects a panel, watches "thinking", types & submits messages

////////////////////////////////////////
// 0) Utility: DOM helpers & debounce //
////////////////////////////////////////

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const debounce = (fn, ms = 100) => {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

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
  stopButton: SITE === 'chatgpt'
    ? '#composer-submit-button[aria-label="Stop streaming"], button[data-testid="stop-button"]'
    : 'button[aria-label="Stop response"], [data-is-streaming="true"] button[aria-label="Stop response"]',
  // Send button (idle) — ChatGPT specific, Claude will use Enter fallback
  sendButton: SITE === 'chatgpt' ? '#composer-submit-button' : 'button[aria-label="Send message"]:not([disabled])',
  // Editor
  editor: SITE === 'chatgpt'
    ? '#prompt-textarea.ProseMirror[contenteditable="true"], div#prompt-textarea[contenteditable="true"]'
    : 'div[role="textbox"].ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]',
  // Fallback textarea (rare)
  fallbackTextarea: 'textarea[name="prompt-textarea"]'
};

function getStopButton() {
  const el = $(selectors.stopButton);
  return el && isVisible(el) ? el : null;
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
  // For ChatGPT, strictly rely on the submit button being in "Stop streaming" state.
  // For Claude, also honor a page-level streaming flag when present.
  const streamingEl = SITE === 'claude' ? document.querySelector('[data-is-streaming="true"]') : null;
  const busy = !!getStopButton() || !!streamingEl;
  if (busy !== lastBusy) {
    lastBusy = busy;
    chrome.runtime.sendMessage({ type: 'PAGE_STATE', busy });
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
  // Insert new text
  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, text);
  } catch {}

  // If execCommand failed or content still empty, try beforeinput/input events
  if (!inserted) {
    try {
      const before = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text });
      ed.dispatchEvent(before);
      const input = new InputEvent('input', { bubbles: true, cancelable: true, data: text });
      ed.dispatchEvent(input);
    } catch {}
  }

  // Paste fallback for ProseMirror if still empty
  if (!getEditorPlainText()) {
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(evt, 'clipboardData', { value: dt });
      ed.dispatchEvent(evt);
    } catch {}
  }

  // Absolute fallback
  if (!getEditorPlainText()) {
    if ('value' in ed) ed.value = text; else ed.textContent = text;
    ed.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
  }
}

function getEditorPlainText() {
  const ed = getEditor();
  if (!ed) return '';
  if ('value' in ed) return (ed.value || '').trim();
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

  // Give the app a moment to compose
  await new Promise(r => setTimeout(r, 80));

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
      chrome.runtime.sendMessage({ type: 'QUEUE_CLEAR' });
      return;
    }
    if (act === 'pause') {
      const isPaused = root.dataset.paused === 'true';
      chrome.runtime.sendMessage({ type: isPaused ? 'RESUME' : 'PAUSE' });
      return;
    }
    if (btn.classList.contains('gqp-remove')) {
      const id = btn.dataset.id;
      chrome.runtime.sendMessage({ type: 'QUEUE_REMOVE', id });
      return;
    }
  });

  const addBtn = root.querySelector('.gqp-add');
  const input = root.querySelector('.gqp-input');
  addBtn.addEventListener('click', () => {
    const text = (input.value || '').trim();
    if (!text) return;
    chrome.runtime.sendMessage({ type: 'QUEUE_ADD', text });
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
  for (const item of queue) {
    const li = document.createElement('li');
    li.className = 'gqp-item';
    li.innerHTML = `
      <span class="gqp-text" title="${item.text.replace(/\"/g, '&quot;')}">${escapeHtml(item.text)}</span>
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

function hookAltEnterQueue() {
  const editRoot = document;
  editRoot.addEventListener('keydown', (e) => {
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
        chrome.runtime.sendMessage({ type: 'QUEUE_ADD', text });
        clearEditor();
      }
      return;
    }
    // Plain Enter: always queue (Shift+Enter still newline)
    if (!e.altKey && !e.metaKey && !e.ctrlKey && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      const text = getEditorPlainText();
      if (text) {
        chrome.runtime.sendMessage({ type: 'QUEUE_ADD', text });
        clearEditor();
      }
    }
  }, true);
}

////////////////////////////////////////
// 6) Messaging with the background   //
////////////////////////////////////////

chrome.runtime.onMessage.addListener(async (msg, _sender, sendResponse) => {
  if (msg.type === 'QUEUE_UPDATED') {
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
      chrome.runtime.sendMessage({ type: 'SUBMITTED', id: msg.id });
    } catch (err) {
      chrome.runtime.sendMessage({ type: 'ERROR', error: String(err?.message || err) });
    }
  }
  return false;
});

// Say hello so background can send us initial state
chrome.runtime.sendMessage({ type: 'HELLO' });

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
    if (act === 'clear') chrome.runtime.sendMessage({ type: 'QUEUE_CLEAR' });
    if (act === 'pause') {
      const isPaused = pop.dataset.paused === 'true';
      chrome.runtime.sendMessage({ type: isPaused ? 'RESUME' : 'PAUSE' });
    }
    if (btn.classList.contains('gqp-remove')) {
      const id = btn.dataset.id;
      chrome.runtime.sendMessage({ type: 'QUEUE_REMOVE', id });
    }
  });
  const inEl = pop.querySelector('.gqp-input');
  const addEl = pop.querySelector('.gqp-add');
  addEl?.addEventListener('click', () => {
    const text = (inEl.value || '').trim();
    if (!text) return;
    chrome.runtime.sendMessage({ type: 'QUEUE_ADD', text });
    inEl.value = '';
    inEl.focus();
  });
  inEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addEl.click(); });
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
  for (const item of queue) {
    const li = document.createElement('li');
    li.className = 'gqp-item';
    li.innerHTML = `
      <span class="gqp-text" title="${item.text.replace(/\"/g, '&quot;')}">${escapeHtml(item.text)}</span>
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
  // ChatGPT actions area
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
    // Place to the left of Share on ChatGPT
    shareBtn.insertAdjacentElement('beforebegin', btn);
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
