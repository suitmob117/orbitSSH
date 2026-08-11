import type { CodrivingAction, CommandRecord } from '@shared/types';

export type ActivityRisk = 'normal' | 'high';
export type ActivityPhase = 'live' | 'history';

export interface CommandActivityState {
  risk: ActivityRisk;
  phase: ActivityPhase;
}

export function takeRecentChronological<T>(items: readonly T[], limit: number): T[] {
  return items.slice(-Math.max(0, limit));
}

const LIVE_ACTION_STATUSES = new Set<CodrivingAction['status']>([
  'pending_approval',
  'queued',
  'running',
  'paused'
]);

/** Keep every approval visible, then show the most recent live/history actions. */
export function prioritizeCodrivingActions(
  actions: readonly CodrivingAction[],
  limit: number
): CodrivingAction[] {
  const pending = actions.filter((action) => action.status === 'pending_approval');
  const remaining = actions.filter((action) => action.status !== 'pending_approval');
  const recent = takeRecentChronological(remaining, Math.max(0, limit - pending.length));
  return [...pending, ...recent].sort((left, right) => {
    const leftPriority = left.status === 'pending_approval' ? 0 : LIVE_ACTION_STATUSES.has(left.status) ? 1 : 2;
    const rightPriority = right.status === 'pending_approval' ? 0 : LIVE_ACTION_STATUSES.has(right.status) ? 1 : 2;
    return leftPriority - rightPriority || left.sequence - right.sequence;
  });
}

export function getCommandActivityState(record: CommandRecord): CommandActivityState {
  return {
    risk: /^Risk:\s*high\b/i.test(record.summary) ? 'high' : 'normal',
    phase: record.finishedAt ? 'history' : 'live'
  };
}
