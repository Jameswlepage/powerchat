// Message types for communication between content and background scripts

export interface QueueItem {
  id: string;
  text: string;
}

export type MessageType =
  | { type: 'HELLO' }
  | { type: 'PAGE_STATE'; busy: boolean }
  | { type: 'QUEUE_ADD'; text: string }
  | { type: 'QUEUE_REMOVE'; id: string }
  | { type: 'QUEUE_UPDATE'; id: string; text: string }
  | { type: 'QUEUE_CLEAR' }
  | { type: 'QUEUE_GET' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'SUBMITTED'; id: string }
  | { type: 'ERROR'; error: string }
  | { type: 'LINKREF_FETCH_MD'; url: string }
  | { type: 'QUEUE_UPDATED'; queue: QueueItem[]; paused: boolean }
  | { type: 'SEND_TEXT'; text: string; id: string };

export type Site = 'chatgpt' | 'claude';
