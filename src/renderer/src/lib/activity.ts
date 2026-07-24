import type { CommandRecord } from '@shared/types';

export type ActivityRisk = 'normal' | 'high';
export type ActivityPhase = 'live' | 'history';

export interface CommandActivityState {
  risk: ActivityRisk;
  phase: ActivityPhase;
}

export function takeRecentChronological<T>(items: readonly T[], limit: number): T[] {
  return items.slice(-Math.max(0, limit));
}

export function getCommandActivityState(record: CommandRecord): CommandActivityState {
  return {
    risk: /^Risk:\s*high\b/i.test(record.summary) ? 'high' : 'normal',
    phase: record.finishedAt ? 'history' : 'live'
  };
}
