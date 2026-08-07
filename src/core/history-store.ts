import { randomUUID } from 'node:crypto';
import type { CommandRecord } from '../shared/types';
import { JsonStore } from './json-store';
import type { AsyncStore } from './profile-store';
import { SqliteStore, type SqliteStorePort } from './sqlite-store';

const MAX_RECORDS = 500;

export class HistoryStore {
  private readonly sqlite: SqliteStorePort;
  private readonly store: AsyncStore<CommandRecord[]>;

  constructor(options: { sqlite?: SqliteStorePort; jsonStore?: AsyncStore<CommandRecord[]> } = {}) {
    this.sqlite = options.sqlite ?? new SqliteStore();
    this.store = options.jsonStore ?? new JsonStore<CommandRecord[]>('history.json', []);
  }

  async list(sessionId?: string): Promise<CommandRecord[]> {
    const records = this.sqlite.status.usingJsonFallback ? await this.store.read() : this.sqlite.listHistory();
    return sessionId ? records.filter((record) => record.sessionId === sessionId) : records;
  }

  async append(record: Omit<CommandRecord, 'id'>): Promise<CommandRecord> {
    const commandRecord: CommandRecord = {
      id: randomUUID(),
      ...record
    };
    if (this.sqlite.status.usingJsonFallback) {
      const records = await this.store.read();
      await this.store.write([...records, commandRecord].slice(-MAX_RECORDS));
    } else {
      this.sqlite.appendHistory(commandRecord);
    }
    return commandRecord;
  }
}
