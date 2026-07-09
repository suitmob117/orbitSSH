import { randomUUID } from 'node:crypto';
import type { CommandRecord } from '../shared/types';
import { JsonStore } from './json-store';

const MAX_RECORDS = 500;

export class HistoryStore {
  private readonly store = new JsonStore<CommandRecord[]>('history.json', []);

  async list(sessionId?: string): Promise<CommandRecord[]> {
    const records = await this.store.read();
    return sessionId ? records.filter((record) => record.sessionId === sessionId) : records;
  }

  async append(record: Omit<CommandRecord, 'id'>): Promise<CommandRecord> {
    const commandRecord: CommandRecord = {
      id: randomUUID(),
      ...record
    };
    const records = await this.store.read();
    await this.store.write([...records, commandRecord].slice(-MAX_RECORDS));
    return commandRecord;
  }
}
