export type TerminalInputAction =
  | { type: 'echo'; data: string }
  | { type: 'submit'; command: string }
  | { type: 'interrupt' }
  | { type: 'unsupported' };

export function formatTerminalEcho(data: string): string {
  let output = '';
  const visibleData = data.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|O.)/g, '');
  for (const character of visibleData) {
    if (character === '\b' || character === '\x7f') output += '\b \b';
    else if (character === '\r' || character === '\n') output += '\r\n';
    else if (character >= ' ' && character !== '\x7f') output += character;
  }
  return output;
}

/**
 * 只跟踪普通单行输入；前端负责本地回显，完整命令在回车后交给共享执行队列。
 * heredoc、全屏程序和复杂交互命令留给后续 shell integration 支持。
 */
export class TerminalCommandTracker {
  private command = '';
  private trackable = true;
  private previousWasCarriageReturn = false;

  consume(data: string): TerminalInputAction[] {
    const actions: TerminalInputAction[] = [];
    let echoBuffer = '';
    const flushEcho = (): void => {
      if (!echoBuffer) return;
      actions.push({ type: 'echo', data: echoBuffer });
      echoBuffer = '';
    };

    for (let index = 0; index < data.length; index += 1) {
      const character = data[index] ?? '';

      if (character === '\n' && this.previousWasCarriageReturn) {
        this.previousWasCarriageReturn = false;
        continue;
      }
      this.previousWasCarriageReturn = character === '\r';

      if (character === '\r' || character === '\n') {
        flushEcho();
        const command = this.command.trim();
        this.command = '';
        actions.push(command && this.trackable
          ? { type: 'submit', command }
          : this.trackable
            ? { type: 'echo', data: character }
            : { type: 'unsupported' });
        this.trackable = true;
        continue;
      }

      if (character === '\x03') {
        flushEcho();
        this.command = '';
        this.trackable = true;
        actions.push({ type: 'interrupt' });
        continue;
      }

      if (character === '\b' || character === '\x7f') {
        // Queue mode echoes input locally. Never let backspace escape the
        // current input buffer and move into remote prompt/output text.
        if (this.command.length > 0) {
          this.command = [...this.command].slice(0, -1).join('');
          echoBuffer += character;
        }
        continue;
      }

      if (character === '\x1b') {
        const rest = data.slice(index);
        const sequence = rest.match(/^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.)/)?.[0] ?? character;
        echoBuffer += sequence;
        this.trackable = false;
        index += sequence.length - 1;
        continue;
      }

      echoBuffer += character;
      if (character >= ' ' && character !== '\x7f') {
        this.command += character;
      } else {
        this.trackable = false;
      }
    }

    flushEcho();
    return actions;
  }
}
