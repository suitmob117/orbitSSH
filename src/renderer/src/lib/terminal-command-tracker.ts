export type TerminalInputAction =
  | { type: 'write'; data: string }
  | { type: 'submit'; command: string };

/**
 * 只跟踪普通单行输入；按键仍由原始 PTY 处理，不在前端模拟 shell。
 * heredoc、全屏程序和复杂交互命令留给后续 shell integration 支持。
 */
export class TerminalCommandTracker {
  private command = '';
  private trackable = true;
  private previousWasCarriageReturn = false;

  consume(data: string): TerminalInputAction[] {
    const actions: TerminalInputAction[] = [];
    let writeBuffer = '';
    const flushWrite = (): void => {
      if (!writeBuffer) return;
      actions.push({ type: 'write', data: writeBuffer });
      writeBuffer = '';
    };

    for (let index = 0; index < data.length; index += 1) {
      const character = data[index] ?? '';

      if (character === '\n' && this.previousWasCarriageReturn) {
        this.previousWasCarriageReturn = false;
        continue;
      }
      this.previousWasCarriageReturn = character === '\r';

      if (character === '\r' || character === '\n') {
        flushWrite();
        const command = this.command.trim();
        this.command = '';
        actions.push(command && this.trackable ? { type: 'submit', command } : { type: 'write', data: character });
        this.trackable = true;
        continue;
      }

      if (character === '\x03') {
        this.command = '';
        this.trackable = true;
        writeBuffer += character;
        continue;
      }

      if (character === '\b' || character === '\x7f') {
        this.command = [...this.command].slice(0, -1).join('');
        writeBuffer += character;
        continue;
      }

      if (character === '\x1b') {
        const rest = data.slice(index);
        const sequence = rest.match(/^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.)/)?.[0] ?? character;
        writeBuffer += sequence;
        this.trackable = false;
        index += sequence.length - 1;
        continue;
      }

      writeBuffer += character;
      if (character >= ' ' && character !== '\x7f') {
        this.command += character;
      } else {
        this.trackable = false;
      }
    }

    flushWrite();
    return actions;
  }
}
