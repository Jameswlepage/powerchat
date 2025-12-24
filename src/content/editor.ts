// Editor interaction: reading, writing, and submitting messages

import { getEditor, getSendButton, getStopButton, SITE } from './site-adapter';
import { placeCaretAtEnd } from './utils';

export function setEditorText(text: string): void {
  const ed = getEditor();
  if (!ed) throw new Error('Composer not found.');

  ed.focus();
  placeCaretAtEnd(ed);

  // Clear existing text
  try {
    document.execCommand('selectAll', false, undefined);
    document.execCommand('insertText', false, ''); // clear
  } catch {
    // ignore
  }

  // Insert new text - try execCommand first, verify with content check
  try {
    document.execCommand('insertText', false, text);
  } catch {
    // ignore
  }

  // Check if text was actually inserted before trying fallbacks
  if (getEditorPlainText()) return;

  // Fallback: try beforeinput/input events
  try {
    const before = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    });
    ed.dispatchEvent(before);
    const input = new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      data: text,
    });
    ed.dispatchEvent(input);
  } catch {
    // ignore
  }

  if (getEditorPlainText()) return;

  // Paste fallback for ProseMirror
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'clipboardData', { value: dt });
    ed.dispatchEvent(evt);
  } catch {
    // ignore
  }

  if (getEditorPlainText()) return;

  // Absolute fallback
  if ('value' in ed) {
    (ed as HTMLTextAreaElement).value = text;
  } else {
    ed.textContent = text;
  }
  ed.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
}

export function getEditorPlainText(): string {
  const ed = getEditor();
  if (!ed) return '';

  if ('value' in ed) {
    return ((ed as HTMLTextAreaElement).value || '').trim();
  }

  // ProseMirror wraps content in <p> elements.
  // Preserve blank lines (empty paragraphs) to avoid losing user formatting.
  const paragraphs = ed.querySelectorAll('p');
  if (paragraphs.length > 0) {
    const lines: string[] = [];
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

export function clearEditor(): void {
  const ed = getEditor();
  if (!ed) return;

  try {
    document.execCommand('selectAll', false, undefined);
    document.execCommand('insertText', false, '');
  } catch {
    if ('value' in ed) {
      (ed as HTMLTextAreaElement).value = '';
    } else {
      ed.textContent = '';
    }
  }
  ed.dispatchEvent(new InputEvent('input', { bubbles: true, data: '' }));
}

export async function typeAndSend(text: string): Promise<void> {
  // Guard: only send when page not busy
  if (getStopButton()) throw new Error('Page is busy (thinking).');
  setEditorText(text);

  // Use microtask + requestAnimationFrame for minimal delay while ensuring
  // ProseMirror has processed the input.
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

  // Prefer clicking a visible send button when available
  let sendBtn = getSendButton();
  if (!sendBtn && SITE === 'claude') {
    // Wait briefly for button to enable after input
    const start = Date.now();
    while (Date.now() - start < 800 && !sendBtn) {
      await new Promise((r) => setTimeout(r, 60));
      sendBtn = getSendButton();
    }
  }
  if (sendBtn) {
    sendBtn.click();
    return;
  }

  // Fallback: simulate Enter on editor
  const ed = getEditor();
  if (!ed) throw new Error('Composer not found for Enter fallback.');
  ed.focus();

  const down = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true });
  const up = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true });
  ed.dispatchEvent(down);
  ed.dispatchEvent(up);
}
