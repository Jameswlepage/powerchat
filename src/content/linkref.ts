// LinkRef feature: @url tokens that expand to markdown on send

import { getEditor, getSendButton } from './site-adapter';
import { escapeHtml, safeSendMessage } from './utils';

const URL_RE = /@https?:\/\/\S+$/;

function hostFrom(u: string): string {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return u;
  }
}

function createToken(url: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'pc-ref';
  span.contentEditable = 'false';
  span.dataset.url = url;
  span.title = url;
  span.innerHTML = `<span class="pc-ref-badge">@</span><span class="pc-ref-host">${escapeHtml(hostFrom(url))}</span>`;

  // Fetch markdown asynchronously via background (scaffold)
  safeSendMessage({ type: 'LINKREF_FETCH_MD', url }, (res: unknown) => {
    const response = res as { ok?: boolean; md?: string } | undefined;
    if (response?.ok && typeof response.md === 'string') {
      span.dataset.md = response.md;
    }
  });

  return span;
}

function replaceTypedUrlWithToken(): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const range = sel.getRangeAt(0);
  const node = range.startContainer;
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

function expandTokensForSend(): void {
  const editor = getEditor();
  if (!editor) return;

  const tokens = editor.querySelectorAll('.pc-ref');
  tokens.forEach((tok) => {
    const el = tok as HTMLElement;
    const url = el.dataset.url || '';
    const md = el.dataset.md || `Referenced URL: ${url}`;
    const textNode = document.createTextNode(md);
    tok.replaceWith(textNode);
  });
}

export function initLinkRefFeature(): void {
  const ed = getEditor();
  if (!ed) return;

  ed.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter' || e.key === ',') {
      replaceTypedUrlWithToken();
    }
  });

  // Hook send button click to expand tokens just before submission
  const sendBtn = getSendButton();
  if (sendBtn) {
    sendBtn.addEventListener('mousedown', expandTokensForSend, true);
    sendBtn.addEventListener('click', expandTokensForSend, true);
  }

  // Cmd/Ctrl+Enter shortcut
  document.addEventListener(
    'keydown',
    (e) => {
      const isMac = navigator.platform.includes('Mac');
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key === 'Enter') expandTokensForSend();
    },
    true
  );
}
