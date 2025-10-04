// bg.js — queue/state lives here per tab

const tabState = new Map(); // tabId -> { queue: [{id,text}], paused, pageBusy, sending }

const keyFor = (tabId) => `queue:${tabId}`;

function randomId(len = 8) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return [...a].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function getState(tabId) {
  let s = tabState.get(tabId);
  if (!s) {
    const saved = (await chrome.storage.local.get(keyFor(tabId)))[keyFor(tabId)];
    s = {
      queue: saved?.queue ?? [],
      paused: saved?.paused ?? false,
      pageBusy: false, // content script updates this
      sending: false   // true while we're dispatching a queued item
    };
    tabState.set(tabId, s);
  }
  return s;
}

async function save(tabId) {
  const s = await getState(tabId);
  await chrome.storage.local.set({
    [keyFor(tabId)]: { queue: s.queue, paused: s.paused }
  });
}

async function broadcast(tabId) {
  const s = await getState(tabId);
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'QUEUE_UPDATED',
      queue: s.queue,
      paused: s.paused
    });
  } catch {
    // tab might be closed or content script not yet injected
  }
}

async function maybeSendNext(tabId) {
  const s = await getState(tabId);

  if (s.paused) return;
  if (s.sending) return;
  if (s.pageBusy) return;
  if (s.queue.length === 0) return;

  const next = s.queue[0];
  s.sending = true;

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SEND_TEXT', text: next.text, id: next.id });
    // We’ll shift the queue only after the content script confirms SUBMITTED.
  } catch {
    s.sending = false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id ?? msg.tabId; // fallback if message comes from elsewhere
  if (!tabId && msg.type !== 'PING') return; // ignore

  (async () => {
    switch (msg.type) {
      case 'HELLO': {
        await getState(tabId);
        await broadcast(tabId);
        sendResponse({ ok: true });
        break;
      }

      case 'PAGE_STATE': {
        const s = await getState(tabId);
        const prev = s.pageBusy;
        s.pageBusy = !!msg.busy;
        if (prev !== s.pageBusy && !s.pageBusy) {
          // just transitioned to idle -> try next
          maybeSendNext(tabId);
        }
        break;
      }

      case 'QUEUE_ADD': {
        const s = await getState(tabId);
        const id = randomId();
        s.queue.push({ id, text: String(msg.text ?? '').trim() });
        await save(tabId);
        await broadcast(tabId);
        // Attempt immediately if idle
        maybeSendNext(tabId);
        sendResponse({ ok: true, id });
        break;
      }

      case 'QUEUE_REMOVE': {
        const s = await getState(tabId);
        s.queue = s.queue.filter(item => item.id !== msg.id);
        await save(tabId);
        await broadcast(tabId);
        sendResponse({ ok: true });
        break;
      }

      case 'QUEUE_UPDATE': {
        const s = await getState(tabId);
        const id = String(msg.id || '');
        const text = String(msg.text || '').trim();
        const idx = s.queue.findIndex(it => it.id === id);
        if (idx !== -1) {
          s.queue[idx] = { ...s.queue[idx], text };
          await save(tabId);
          await broadcast(tabId);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'not_found' });
        }
        break;
      }

      case 'QUEUE_CLEAR': {
        const s = await getState(tabId);
        s.queue = [];
        await save(tabId);
        await broadcast(tabId);
        sendResponse({ ok: true });
        break;
      }

      case 'QUEUE_GET': {
        const s = await getState(tabId);
        sendResponse({ ok: true, queue: s.queue, paused: s.paused });
        break;
      }

      case 'PAUSE': {
        const s = await getState(tabId);
        s.paused = true;
        await save(tabId);
        await broadcast(tabId);
        sendResponse({ ok: true });
        break;
      }

      case 'RESUME': {
        const s = await getState(tabId);
        s.paused = false;
        await save(tabId);
        await broadcast(tabId);
        // Try to send if conditions allow
        maybeSendNext(tabId);
        sendResponse({ ok: true });
        break;
      }

      case 'SUBMITTED': {
        // Content script successfully entered and clicked send for the head item.
        const s = await getState(tabId);
        if (s.queue[0]?.id === msg.id) {
          s.queue.shift();
          s.sending = false;
          await save(tabId);
          await broadcast(tabId);
        } else {
          s.sending = false; // desync fallback
        }
        // We do NOT immediately send next; we wait for PAGE_STATE to go busy->idle.
        break;
      }

      case 'ERROR': {
        const s = await getState(tabId);
        s.sending = false;
        // Keep the item in queue; you can decide to drop it instead.
        await broadcast(tabId);
        console.warn('Content error:', msg.error);
        // Retry shortly; if page is still busy, maybeSendNext will noop and PAGE_STATE idle will trigger again.
        setTimeout(() => {
          maybeSendNext(tabId);
        }, 400);
        break;
      }

      default:
        break;
    }
  })();

  return true; // keep the message channel open for async sendResponse
});
