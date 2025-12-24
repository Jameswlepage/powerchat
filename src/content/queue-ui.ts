// Queue UI: popover, header button, and inline editing

import type { QueueItem } from '../shared/types';
import { SITE, getStopButton } from './site-adapter';
import { debounce, escapeHtml, placeCaretAtEnd, safeSendMessage } from './utils';
import { createIcon } from './icons';

const POPOVER_ID = 'gqp-queue-popover';
const HEADER_QUEUE_BTN_ID = 'gqp-header-queue-btn';

let lastQueueLength = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Popover
// ─────────────────────────────────────────────────────────────────────────────

export function createPopover(): void {
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

  // Inject icons
  const addBtn = pop.querySelector('.gqp-add');
  const pauseBtn = pop.querySelector('.gqp-btn[data-act="pause"]');
  const clearBtn = pop.querySelector('.gqp-btn[data-act="clear"]');

  if (addBtn) addBtn.appendChild(createIcon('plus'));
  if (pauseBtn) {
    const pauseIcon = createIcon('pause');
    const playIcon = createIcon('play');
    pauseIcon.classList.add('ico-pause');
    playIcon.classList.add('ico-play');
    playIcon.style.display = 'none';
    pauseBtn.appendChild(pauseIcon);
    pauseBtn.appendChild(playIcon);
  }
  if (clearBtn) clearBtn.appendChild(createIcon('trash'));

  // Events
  pop.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest('button');
    if (!btn) return;

    const act = btn.getAttribute('data-act');
    if (act === 'clear') safeSendMessage({ type: 'QUEUE_CLEAR' });
    if (act === 'pause') {
      const isPaused = pop.dataset.paused === 'true';
      safeSendMessage({ type: isPaused ? 'RESUME' : 'PAUSE' });
    }
    if (btn.classList.contains('gqp-remove')) {
      const id = btn.getAttribute('data-id');
      if (id) safeSendMessage({ type: 'QUEUE_REMOVE', id });
    }
  });

  const inEl = pop.querySelector<HTMLInputElement>('.gqp-input');
  const addEl = pop.querySelector<HTMLButtonElement>('.gqp-add');

  addEl?.addEventListener('click', () => {
    const text = (inEl?.value || '').trim();
    if (!text) return;
    safeSendMessage({ type: 'QUEUE_ADD', text });
    if (inEl) {
      inEl.value = '';
      inEl.focus();
    }
  });

  inEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addEl?.click();
  });

  // Inline edit events
  pop.addEventListener('dblclick', (e) => {
    const txt = (e.target as Element).closest('.gqp-text');
    if (txt) startInlineEdit(txt as HTMLElement);
  });

  pop.addEventListener(
    'keydown',
    (e) => {
      const txt = (e.target as Element).closest('.gqp-text') as HTMLElement | null;
      if (!txt) return;
      if (txt.isContentEditable) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          commitInlineEdit(txt);
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancelInlineEdit(txt);
        }
      }
    },
    true
  );

  pop.addEventListener(
    'blur',
    (e) => {
      const txt = (e.target as Element).closest('.gqp-text') as HTMLElement | null;
      if (txt?.isContentEditable) commitInlineEdit(txt);
    },
    true
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// UI Update
// ─────────────────────────────────────────────────────────────────────────────

export function updateUIRoot(root: HTMLElement | null, queue: QueueItem[] = [], paused = false): void {
  if (!root) return;

  root.dataset.paused = String(!!paused);

  const pauseBtn = root.querySelector('.gqp-btn[data-act="pause"]');
  const icoPause = pauseBtn?.querySelector('.ico-pause') as HTMLElement | null;
  const icoPlay = pauseBtn?.querySelector('.ico-play') as HTMLElement | null;

  if (pauseBtn && icoPause && icoPlay) {
    if (paused) {
      icoPause.style.display = 'none';
      icoPlay.style.display = 'block';
    } else {
      icoPause.style.display = 'block';
      icoPlay.style.display = 'none';
    }
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
      <span class="gqp-text" data-id="${item.id}" title="${item.text.replace(/"/g, '&quot;')}">${escapeHtml(item.text)}</span>
      <button class="gqp-btn gqp-remove" data-id="${item.id}" title="Remove" aria-label="Remove"></button>
    `;
    const removeBtn = li.querySelector('.gqp-remove');
    if (removeBtn) removeBtn.appendChild(createIcon('x'));
    list.appendChild(li);
  }

  const status = root.querySelector('.gqp-status');
  const busy = !!getStopButton();
  const state = paused ? 'paused' : busy ? 'busy' : 'idle';
  root.dataset.state = state;
  if (status) status.textContent = state === 'busy' ? 'thinking…' : state;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline Editing
// ─────────────────────────────────────────────────────────────────────────────

function startInlineEdit(el: HTMLElement): void {
  if (!el || el.isContentEditable) return;
  el.dataset.prev = el.textContent || '';
  el.contentEditable = 'true';
  el.spellcheck = true;
  el.classList.add('gqp-editing');
  el.focus();
  placeCaretAtEnd(el);
}

function commitInlineEdit(el: HTMLElement): void {
  if (!el?.isContentEditable) return;
  const id = el.dataset.id;
  const prev = el.dataset.prev || '';
  const text = (el.textContent || '').trim();
  el.contentEditable = 'false';
  el.classList.remove('gqp-editing');
  delete el.dataset.prev;
  if (text === prev || !id) return;
  safeSendMessage({ type: 'QUEUE_UPDATE', id, text });
}

function cancelInlineEdit(el: HTMLElement): void {
  if (!el?.isContentEditable) return;
  const prev = el.dataset.prev || '';
  el.textContent = prev;
  el.contentEditable = 'false';
  el.classList.remove('gqp-editing');
  delete el.dataset.prev;
}

// ─────────────────────────────────────────────────────────────────────────────
// Header Button
// ─────────────────────────────────────────────────────────────────────────────

function positionPopover(btn: HTMLElement): void {
  const pop = document.getElementById(POPOVER_ID);
  if (!pop || !btn) return;

  const r = btn.getBoundingClientRect();
  const margin = 8;
  const top = r.bottom + margin + window.scrollY;
  let left = r.left + window.scrollX;
  const maxLeft = window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 12;
  if (left > maxLeft) left = Math.max(12, maxLeft);
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
}

export function createHeaderQueueButton(): void {
  if (document.getElementById(HEADER_QUEUE_BTN_ID)) return;

  const header = document.querySelector('header#page-header, header[data-testid="page-header"], header');
  if (!header) return;

  // ChatGPT layout: prefer the centered header actions container
  if (SITE === 'chatgpt') {
    const centerContainer =
      header.querySelector('#conversation-header-actions')?.closest('.flex.items-center.justify-center.gap-3') ||
      header.querySelector('.flex.items-center.justify-center.gap-3');

    if (centerContainer) {
      const btn = createQueueButton();
      const anchor = centerContainer.querySelector('.flex-shrink-0');
      if (anchor?.nextSibling) {
        centerContainer.insertBefore(btn, anchor.nextSibling);
      } else {
        centerContainer.appendChild(btn);
      }
      setupPopoverToggle(btn);
      updateHeaderIndicatorCount(lastQueueLength);
      return;
    }
  }

  // Generic ChatGPT / Claude actions area (fallback)
  const shareBtn = header.querySelector('#conversation-header-actions [data-testid="share-chat-button"]');
  let claudeActions: Element | null = null;
  let rightGroup: Element | null = null;

  if (!shareBtn) {
    claudeActions = document.querySelector('[data-testid="wiggle-controls-actions"]');
    rightGroup = header.querySelector('.right-3.flex.gap-2, .right-3');
  }

  const btn = createQueueButton();

  if (shareBtn) {
    const actions = shareBtn.closest('#conversation-header-actions') || shareBtn.parentElement;
    if (actions) {
      actions.insertBefore(btn, shareBtn);
    } else {
      shareBtn.insertAdjacentElement('beforebegin', btn);
    }
  } else if (claudeActions) {
    const claudeShare = claudeActions.querySelector('[data-testid="wiggle-controls-actions-share"]');
    if (claudeShare) {
      claudeShare.insertAdjacentElement('beforebegin', btn);
    } else {
      claudeActions.insertAdjacentElement('afterbegin', btn);
    }
  } else if (rightGroup) {
    rightGroup.insertAdjacentElement('afterbegin', btn);
  } else {
    const wrapper = header.querySelector('.flex.w-full.items-center.justify-between');
    (wrapper || header).appendChild(btn);
  }

  setupPopoverToggle(btn);
  updateHeaderIndicatorCount(lastQueueLength);
}

function createQueueButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = HEADER_QUEUE_BTN_ID;
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Open queue');
  btn.title = 'Open queue';
  btn.appendChild(createIcon('queue', { size: 18 }));

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Queue';
  btn.appendChild(label);

  return btn;
}

function setupPopoverToggle(btn: HTMLButtonElement): void {
  let outsideHandler: ((e: MouseEvent) => void) | null = null;

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

      outsideHandler = (e: MouseEvent) => {
        if (!pop.contains(e.target as Node) && e.target !== btn && !btn.contains(e.target as Node)) {
          pop.classList.add('hidden');
          if (outsideHandler) {
            document.removeEventListener('mousedown', outsideHandler);
            outsideHandler = null;
          }
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Header Indicator
// ─────────────────────────────────────────────────────────────────────────────

export function updateHeaderIndicator(queue: QueueItem[] = []): void {
  lastQueueLength = Array.isArray(queue) ? queue.length : 0;
  updateHeaderIndicatorCount(lastQueueLength);
}

function updateHeaderIndicatorCount(n = 0): void {
  const btn = document.getElementById(HEADER_QUEUE_BTN_ID);
  if (!btn) return;
  btn.dataset.hasItems = String(n > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Observer for re-attaching header button
// ─────────────────────────────────────────────────────────────────────────────

export function initHeaderObserver(): void {
  const headerObs = new MutationObserver(
    debounce(() => {
      createHeaderQueueButton();
    }, 100)
  );
  headerObs.observe(document.documentElement, { subtree: true, childList: true });
  createHeaderQueueButton();
}
