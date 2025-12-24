// Markdown export feature: adds export options to ChatGPT menus

import { SITE } from './site-adapter';
import { escapeHtml } from './utils';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ConversationMessage {
  author?: { role?: string };
  content?: {
    content_type?: string;
    parts?: Array<string | { text?: string; content?: string; type?: string; alt?: string; metadata?: { alt?: string } }>;
    text?: string;
    thoughts?: Array<{ summary?: string; content?: string }>;
    code?: string;
    result?: string;
  };
  metadata?: { is_visually_hidden_from_conversation?: boolean };
}

interface ConversationNode {
  message?: ConversationMessage;
  parent?: string;
  children?: string[];
}

interface ConversationData {
  title?: string;
  mapping?: Record<string, ConversationNode>;
}

// ─────────────────────────────────────────────────────────────────────────────
// OAI Header Extraction
// ─────────────────────────────────────────────────────────────────────────────

function getOaiDeviceId(): string | null {
  // Try localStorage first (ChatGPT stores device ID here)
  try {
    const stored = localStorage.getItem('oai-did');
    if (stored) return stored;
  } catch { /* ignore */ }

  // Try parsing from cookies
  try {
    const match = document.cookie.match(/oai-did=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  } catch { /* ignore */ }

  // Try extracting from page state
  try {
    const ctx = (window as unknown as { __reactRouterContext?: { state?: { oaiDeviceId?: string }; clientBootstrap?: { deviceId?: string } } }).__reactRouterContext;
    const deviceId = ctx?.state?.oaiDeviceId || ctx?.clientBootstrap?.deviceId;
    if (deviceId) return deviceId;
  } catch { /* ignore */ }

  return null;
}

function getOaiClientVersion(): string | null {
  try {
    const nextData = document.getElementById('__NEXT_DATA__');
    if (nextData?.textContent) {
      const data = JSON.parse(nextData.textContent) as { buildId?: string };
      if (data?.buildId) return `prod-${data.buildId}`;
    }
  } catch { /* ignore */ }

  try {
    const ctx = (window as unknown as { __reactRouterContext?: { clientBootstrap?: { version?: string } } }).__reactRouterContext;
    if (ctx?.clientBootstrap?.version) return ctx.clientBootstrap.version;
  } catch { /* ignore */ }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch & Convert
// ─────────────────────────────────────────────────────────────────────────────

const conversationMarkdownCache = new Map<string, string>();

async function fetchConversationMarkdown(conversationId: string): Promise<string> {
  if (!conversationId) return '';
  if (conversationMarkdownCache.has(conversationId)) {
    return conversationMarkdownCache.get(conversationId)!;
  }

  // Try to reuse the app's access token when available
  let auth = '';
  try {
    const ctx = (window as unknown as { __reactRouterContext?: { clientBootstrap?: { session?: { account?: { accessToken?: string } } } } }).__reactRouterContext;
    const token = ctx?.clientBootstrap?.session?.account?.accessToken;
    if (typeof token === 'string' && token) {
      auth = `Bearer ${token}`;
    }
  } catch { /* ignore */ }

  try {
    const headers: Record<string, string> = {
      accept: '*/*',
      'oai-language': navigator.language || 'en-US',
    };

    const deviceId = getOaiDeviceId();
    if (deviceId) {
      headers['oai-device-id'] = deviceId;
    }

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
      language: headers['oai-language'],
    });

    const res = await fetch(`/backend-api/conversation/${conversationId}`, {
      method: 'GET',
      credentials: 'include',
      headers,
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

    const data = (await res.json()) as ConversationData;
    const md = conversationToMarkdown(data);
    conversationMarkdownCache.set(conversationId, md);
    return md;
  } catch (err) {
    console.error('[PowerChat] Failed to fetch conversation JSON:', err);
    alert((err as Error).message || 'Could not load conversation from server.');
    return '';
  }
}

function conversationToMarkdown(conv: ConversationData): string {
  if (!conv) return '';
  const title = conv.title || 'ChatGPT Conversation';
  const mapping = conv.mapping || {};

  // Find root node (no parent or parent is null/missing from mapping)
  const rootId = Object.keys(mapping).find((id) => {
    const n = mapping[id];
    return n && (!n.parent || !mapping[n.parent]);
  });

  if (!rootId) return `# ${title}\n\n(Empty conversation)\n`;

  // Traverse forward via children (DFS, following first child to get main thread)
  const messages: ConversationMessage[] = [];
  const seen = new Set<string>();
  const stack = [rootId];

  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);

    const node = mapping[nodeId];
    if (!node) continue;

    // Collect message if visible
    if (node.message) {
      const meta = node.message.metadata || {};
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
    const role = msg.author?.role || 'assistant';
    if (role === 'system') continue;
    const headerRole = role.charAt(0).toUpperCase() + role.slice(1);
    const body = renderMessageContentToMarkdown(msg);
    if (!body.trim()) continue;
    out += `## ${headerRole}\n\n${body.trim()}\n\n`;
  }
  return out.trim() + '\n';
}

function renderMessageContentToMarkdown(message: ConversationMessage): string {
  const c = message?.content;
  if (!c) return '';

  const contentType = c.content_type;

  switch (contentType) {
    case 'thoughts': {
      const thoughts = c.thoughts || [];
      if (!thoughts.length) return '';
      const thoughtsText = thoughts
        .map((t) => {
          const summary = t.summary || 'Thinking';
          const content = t.content || '';
          return `**${summary}**\n${content}`;
        })
        .join('\n\n');
      return `<details>\n<summary>💭 Thinking</summary>\n\n${thoughtsText}\n</details>`;
    }

    case 'reasoning_recap': {
      const recap = c.text || '';
      return recap ? `*${recap}*` : '';
    }

    case 'code': {
      const code = c.code || c.text || '';
      const result = c.result || '';
      let out = '';
      if (code) out += '```\n' + code + '\n```';
      if (result) out += '\n\n**Result:**\n```\n' + result + '\n```';
      return out;
    }

    case 'model_editable_context':
      return '';

    case 'text':
    default: {
      const parts = Array.isArray(c.parts) ? c.parts : typeof c.text === 'string' ? [c.text] : [];
      if (!parts.length && typeof c === 'string') return c as unknown as string;

      return parts
        .map((part) => {
          if (!part) return '';
          if (typeof part === 'string') return part;
          if (typeof part === 'object') {
            if ('text' in part && typeof part.text === 'string') return part.text;
            if ('content' in part && typeof part.content === 'string') return part.content;
            if (part.type === 'image_file' || part.type === 'image' || part.type === 'image_asset_pointer') {
              const alt = part.alt || part.metadata?.alt || 'image';
              return `![${alt}](image)`;
            }
          }
          return '';
        })
        .filter(Boolean)
        .join('\n\n');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Download Helpers
// ─────────────────────────────────────────────────────────────────────────────

function downloadMarkdownFile(md: string, name: string): void {
  if (!md) return;
  const base =
    (name || 'conversation')
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

function getConversationTitleForDownload(anchorEl: Element | null): string {
  if (!anchorEl) return '';
  const titleEl = anchorEl.querySelector('[title]') || anchorEl.querySelector('span[dir="auto"]');
  const title = (titleEl && (titleEl.getAttribute('title') || titleEl.textContent)) || '';
  return title.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Menu Enhancement
// ─────────────────────────────────────────────────────────────────────────────

function buildHistoryMenuItem(labelText: string, iconKind: 'copy' | 'download', testId: string): HTMLDivElement {
  const item = document.createElement('div');
  item.setAttribute('role', 'menuitem');
  item.tabIndex = 0;
  item.className = 'group __menu-item gap-1.5';
  item.dataset.orientation = 'vertical';
  item.dataset.radixCollectionItem = '';
  if (testId) item.dataset.testid = testId;

  const iconWrap = document.createElement('div');
  iconWrap.className = 'flex items-center justify-center group-disabled:opacity-50 group-data-disabled:opacity-50 icon';
  iconWrap.innerHTML =
    iconKind === 'download'
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

function tryEnhanceMarkdownMenu(menuEl: Element): void {
  if (!menuEl || (menuEl as HTMLElement).dataset.gqpMdMenu === 'true') return;

  const labelId = menuEl.getAttribute('aria-labelledby');
  if (!labelId) return;
  const trigger = document.getElementById(labelId);
  if (!trigger) return;

  const testId = trigger.getAttribute('data-testid') || '';
  const isSidebarHistory = /^history-item-\d+-options$/.test(testId);
  const isHeaderMenu = !!trigger.closest('header#page-header, header[data-testid="page-header"]');
  let conversationId: string | null = null;
  let downloadTitleSourceEl: Element | null = null;

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
    downloadTitleSourceEl = document.querySelector('h1, [data-testid="conversation-title"]');
  }

  if (!conversationId) return;

  // Ensure it's the expected chat menu (must have a delete item)
  const deleteItem = menuEl.querySelector('[data-testid="delete-chat-menu-item"]');
  if (!deleteItem) return;
  if (isSidebarHistory) {
    const shareItem = menuEl.querySelector('[data-testid="share-chat-menu-item"]');
    if (!shareItem) return;
  }

  (menuEl as HTMLElement).dataset.gqpMdMenu = 'true';

  const copyItem = buildHistoryMenuItem('Copy as Markdown', 'copy', 'gqp-copy-md-menu-item');
  const downloadItem = buildHistoryMenuItem('Download as Markdown', 'download', 'gqp-download-md-menu-item');

  deleteItem.parentNode!.insertBefore(downloadItem, deleteItem);
  deleteItem.parentNode!.insertBefore(copyItem, downloadItem);

  const convId = conversationId; // Capture for closure
  const titleSource = downloadTitleSourceEl;

  copyItem.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const menu = (e.target as Element).closest('[role="menu"]') as HTMLElement | null;
    if (menu) menu.style.display = 'none';
    try {
      console.log('[PowerChat] Fetching conversation:', convId);
      const md = await fetchConversationMarkdown(convId);
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
    const menu = (e.target as Element).closest('[role="menu"]') as HTMLElement | null;
    if (menu) menu.style.display = 'none';
    try {
      console.log('[PowerChat] Fetching conversation for download:', convId);
      const md = await fetchConversationMarkdown(convId);
      if (!md) return;
      const title = getConversationTitleForDownload(titleSource) || convId;
      downloadMarkdownFile(md, title);
      console.log('[PowerChat] Downloaded successfully');
    } catch (err) {
      console.error('[PowerChat] Download as Markdown failed:', err);
      alert('Could not download conversation as Markdown.');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────

export function initExportFeature(): void {
  if (SITE !== 'chatgpt') return;

  // Hook directly off Radix trigger clicks (header + history 3-dots)
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;

      const btn = target.closest(
        'button[data-testid="conversation-options-button"], button[data-testid^="history-item-"][data-testid$="-options"]'
      );
      if (!btn) return;

      // Radix wraps the button in a div that gets used for aria-labelledby
      const wrapper = btn.parentElement && /^radix-/.test(btn.parentElement.id) ? btn.parentElement : btn;
      const labelId = wrapper.id || btn.id;
      if (!labelId) return;

      // Allow Radix to mount/update the popover first
      setTimeout(() => {
        const menu = document.querySelector(`div[role="menu"][data-radix-menu-content][aria-labelledby="${labelId}"]`);
        if (menu) tryEnhanceMarkdownMenu(menu);
      }, 0);
    },
    true
  );

  // Fallback: in case menus are already mounted when we load
  document.querySelectorAll('div[role="menu"][data-radix-menu-content]').forEach((el) => tryEnhanceMarkdownMenu(el));
}
