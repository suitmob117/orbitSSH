import type {
  CodrivingAction,
  CodrivingSessionState,
  RuntimeLeaseRecord
} from '../shared/types';

export interface CodrivingLedgerSnapshot {
  actions: CodrivingAction[];
  sessions: CodrivingSessionState[];
}

/**
 * 共驾持久化的唯一接口。调用方只描述事实，SQLite 表结构、事务和审批索引都隐藏在实现内部。
 */
export interface CodrivingLedger {
  loadCodrivingState(): CodrivingLedgerSnapshot;
  recordCodrivingAction(action: CodrivingAction): void;
  saveCodrivingSessionState(state: CodrivingSessionState): void;
  replaceRuntimeLeases(leases: RuntimeLeaseRecord[]): void;
}
