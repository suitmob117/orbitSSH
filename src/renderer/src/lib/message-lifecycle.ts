const TRANSIENT_MESSAGE_DELAYS: Readonly<Record<string, number>> = {
  '连接成功': 2_500
};

export function getMessageAutoDismissMs(message?: string): number | undefined {
  return message ? TRANSIENT_MESSAGE_DELAYS[message] : undefined;
}
