// Site detection and selectors for ChatGPT and Claude

import type { Site } from '../shared/types';
import { $, isVisible } from './utils';

export const SITE: Site = (() => {
  const h = location.hostname;
  if (h.includes('claude.ai')) return 'claude';
  return 'chatgpt';
})();

const selectors = {
  // Thinking state selectors per site
  // Note: Pro thinking mode uses different indicators (see getStopButton)
  stopButton:
    SITE === 'chatgpt'
      ? '#composer-submit-button[aria-label="Stop streaming"], button[data-testid="stop-button"]'
      : 'button[aria-label="Stop response"], [data-is-streaming="true"] button[aria-label="Stop response"]',
  // Pro thinking spinner (animated blue spinner in header during thinking)
  proThinkingSpinner: 'svg.animate-spin.text-blue-400',
  // Pro thinking Stop button (appears in bottom bar during thinking)
  proStopButton: 'div[slot="trailing"] button.btn-secondary',
  // Send button (idle) — ChatGPT uses dynamic button, Claude has labeled button
  sendButton:
    SITE === 'chatgpt'
      ? 'button[data-testid="send-button"], button[aria-label="Send message"], button.composer-submit-button-color[aria-label="Send message"]'
      : 'button[aria-label="Send message"]:not([disabled])',
  // Editor
  editor:
    SITE === 'chatgpt'
      ? '#prompt-textarea.ProseMirror[contenteditable="true"], div#prompt-textarea[contenteditable="true"]'
      : 'div[role="textbox"].ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]',
  // Fallback textarea (rare)
  fallbackTextarea: 'textarea[name="prompt-textarea"]',
};

export function getStopButton(): Element | null {
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

export function getSendButton(): HTMLButtonElement | null {
  const btn = $<HTMLButtonElement>(selectors.sendButton);
  if (btn && isVisible(btn)) {
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    // If it looks like a stop button, it's not a "send" opportunity.
    if (label.includes('stop')) return null;
    return btn;
  }
  return null;
}

export function getEditor(): HTMLElement | null {
  let ed = $<HTMLElement>(selectors.editor);
  if (ed && isVisible(ed)) return ed;

  ed = $<HTMLElement>(selectors.fallbackTextarea);
  if (ed && isVisible(ed)) return ed;

  // Last resort: any visible contenteditable in the composer
  const candidates = document.querySelectorAll<HTMLElement>('div[contenteditable="true"]');
  for (const el of candidates) {
    if (isVisible(el)) return el;
  }

  return null;
}
