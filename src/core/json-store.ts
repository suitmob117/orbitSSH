import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureAppDataDir } from './paths';

export class JsonStore<T> {
  constructor(
    private readonly fileName: string,
    private readonly fallback: T
  ) {}

  async read(): Promise<T> {
    const dir = await ensureAppDataDir();
    const file = path.join(dir, this.fileName);

    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.fallback;
      }
      throw error;
    }
  }

  async write(value: T): Promise<void> {
    const dir = await ensureAppDataDir();
    const file = path.join(dir, this.fileName);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temp, file);
  }
}
