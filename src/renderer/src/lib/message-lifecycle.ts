const SUCCESS_MESSAGE_DELAY_MS = 4_000;
const ERROR_MESSAGE_DELAY_MS = 8_000;

export type MessageKind = 'success' | 'error' | 'blocking';

export function getMessageAutoDismissMs(kind?: MessageKind): number | undefined {
  if (!kind || kind === 'blocking') return undefined;
  return kind === 'error' ? ERROR_MESSAGE_DELAY_MS : SUCCESS_MESSAGE_DELAY_MS;
}
