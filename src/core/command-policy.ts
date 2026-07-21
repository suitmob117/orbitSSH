import type { AuthorizationLevel } from '../shared/types';

export type CommandRisk = 'readonly' | 'write' | 'high';

export interface CommandAssessment {
  risk: CommandRisk;
  reason: string;
}

export interface AuthorizationDecision extends CommandAssessment {
  allowed: boolean;
}

const OTHER_HIGH_RISK = /^(?:mkfs(?:\..*)?|shutdown|reboot|userdel|passwd|visudo|iptables|ufw|firewall-cmd)$/i;
const WRITE_RISK_EXECUTABLES = new Set([
  'rm',
  'mv',
  'cp',
  'chmod',
  'chown',
  'mkdir',
  'touch',
  'tee',
  'apt',
  'apt-get',
  'yum',
  'dnf'
]);
const READONLY_EXECUTABLES = new Set([
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'grep',
  'stat',
  'df',
  'du',
  'free',
  'top',
  'ps',
  'whoami',
  'id',
  'uname',
  'uptime'
]);
const COMPLEX_SHELL_SYNTAX = /(?:\r|\n|&|\|\||[;|<>`]|\$\()/;
const COMMON_EXECUTABLE_PATH = /^\/(?:usr\/)?s?bin\/([^/]+)$/i;
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_COMMAND_LENGTH = 32_768;
const MAX_WRAPPER_DEPTH = 32;
const COMMAND_OPTIONS_WITH_VALUE = new Set<string>();
const SUDO_OPTIONS_WITH_VALUE = new Set([
  '-u',
  '-g',
  '-h',
  '-p',
  '-r',
  '-t',
  '-C',
  '-D',
  '--user',
  '--group',
  '--host',
  '--prompt',
  '--role',
  '--type',
  '--close-from',
  '--chdir'
]);
const ENV_OPTIONS_WITH_VALUE = new Set(['-u', '-C', '--unset', '--chdir']);
const SYSTEMCTL_OPTIONS_WITH_VALUE = new Set([
  '-H',
  '-M',
  '-t',
  '-p',
  '-s',
  '--host',
  '--machine',
  '--type',
  '--state',
  '--property',
  '--job-mode',
  '--root',
  '--image',
  '--image-policy',
  '--preset-mode',
  '--kill-who',
  '--signal',
  '--what',
  '--uid'
]);

interface ParsedShellCommand {
  executable: string;
  args: string[];
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      current += character;
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ';' || character === '|' || character === '&' || /[\r\n]/.test(character)) {
      if (current.trim()) {
        segments.push(current);
      }
      current = '';
      if ((character === '|' || character === '&') && command[index + 1] === character) {
        index += 1;
      }
      continue;
    }
    current += character;
  }

  if (current.trim()) {
    segments.push(current);
  }
  return segments;
}

function tokenizeShellSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;

  const pushCurrent = () => {
    if (current) {
      tokens.push(current);
      current = '';
    }
  };

  for (const character of segment) {
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      pushCurrent();
    } else {
      current += character;
    }
  }
  pushCurrent();
  return tokens;
}

function executableName(token: string): string | undefined {
  if (/^[\w.-]+$/.test(token)) {
    return token.toLowerCase();
  }
  const commonExecutable = COMMON_EXECUTABLE_PATH.exec(token)?.[1];
  if (commonExecutable) {
    return commonExecutable.toLowerCase();
  }
  if (token.startsWith('/') && token.endsWith('/rm')) {
    return 'rm';
  }
  return undefined;
}

function optionEnd(tokens: string[], optionsWithValue: ReadonlySet<string>): number {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') {
      return index + 1;
    }
    if (!token.startsWith('-') || token === '-') {
      return index;
    }
    const optionName = token.split('=', 1)[0];
    if (optionsWithValue.has(optionName) && !token.includes('=')) {
      index += 2;
    } else {
      index += 1;
    }
  }
  return index;
}

function parseActualCommand(tokens: string[]): ParsedShellCommand | undefined {
  let remainingTokens = tokens;

  for (let wrapperDepth = 0; wrapperDepth <= MAX_WRAPPER_DEPTH; wrapperDepth += 1) {
    let index = 0;
    while (ENVIRONMENT_ASSIGNMENT.test(remainingTokens[index] ?? '')) {
      index += 1;
    }
    if (index >= remainingTokens.length) {
      return undefined;
    }

    const executable = executableName(remainingTokens[index]);
    if (!executable) {
      return undefined;
    }
    const args = remainingTokens.slice(index + 1);

    if (executable === 'command' && (args[0] === '-v' || args[0] === '-V')) {
      return { executable, args };
    }
    const wrapperOptions =
      executable === 'command'
        ? COMMAND_OPTIONS_WITH_VALUE
        : executable === 'env'
          ? ENV_OPTIONS_WITH_VALUE
          : executable === 'sudo'
            ? SUDO_OPTIONS_WITH_VALUE
            : undefined;
    if (!wrapperOptions) {
      return { executable, args };
    }
    if (wrapperDepth === MAX_WRAPPER_DEPTH) {
      return undefined;
    }
    remainingTokens = args.slice(optionEnd(args, wrapperOptions));
  }

  return undefined;
}

function systemctlCommand(args: string[]): ParsedShellCommand | undefined {
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      break;
    }

    const optionName = token.split('=', 1)[0];
    if (SYSTEMCTL_OPTIONS_WITH_VALUE.has(optionName) && !token.includes('=')) {
      if (index + 1 >= args.length || args[index + 1].startsWith('-')) {
        return undefined;
      }
      index += 2;
    } else {
      index += 1;
    }
  }

  const executable = args[index]?.toLowerCase();
  return executable ? { executable, args: args.slice(index + 1) } : undefined;
}

function isReadonlyCommand(command: string): boolean {
  const tokens = tokenizeShellSegment(command);
  const executable = executableName(tokens[0] ?? '');
  if (!executable) {
    return false;
  }

  const args = tokens.slice(1);
  if (READONLY_EXECUTABLES.has(executable)) {
    return true;
  }
  if (executable === 'command') {
    return args[0] === '-v' || args[0] === '-V';
  }
  if (executable === 'systemctl') {
    return systemctlCommand(args)?.executable === 'status';
  }
  return false;
}

function isDestructiveRm(command: ParsedShellCommand): boolean {
  if (command.executable !== 'rm') {
    return false;
  }

  let recursive = false;
  let force = false;
  for (const token of command.args) {
    if (token === '--') {
      break;
    }
    if (token === '--recursive') {
      recursive = true;
    } else if (token === '--force') {
      force = true;
    } else if (/^-[^-]/.test(token)) {
      recursive ||= token.includes('r') || token.includes('R');
      force ||= token.includes('f');
    }
  }
  return recursive && force;
}

function hasOtherHighRiskCommand(command: ParsedShellCommand): boolean {
  if (command.executable === 'dd') {
    return command.args.some((argument) => argument.startsWith('if='));
  }
  if (command.executable === 'systemctl') {
    return command.args.some(
      (argument, index) =>
        argument.toLowerCase() === 'restart' &&
        /^(?:ssh|sshd)$/i.test(command.args[index + 1] ?? '')
    );
  }
  return OTHER_HIGH_RISK.test(command.executable);
}

function isHighRiskCommand(command: string, shellDepth = 0): boolean {
  return splitShellSegments(command).some((segment) => {
    const parsed = parseActualCommand(tokenizeShellSegment(segment));
    if (!parsed) {
      return false;
    }
    if (parsed.executable === 'bash' || parsed.executable === 'sh') {
      const commandOption = parsed.args.findIndex(
        (argument) => argument === '-c' || /^-[^-]*c/.test(argument)
      );
      const script = parsed.args[commandOption + 1];
      return (
        shellDepth < MAX_WRAPPER_DEPTH &&
        commandOption >= 0 &&
        Boolean(script) &&
        isHighRiskCommand(script, shellDepth + 1)
      );
    }
    return isDestructiveRm(parsed) || hasOtherHighRiskCommand(parsed);
  });
}

function isWriteRiskCommand(command: string, shellDepth = 0): boolean {
  return splitShellSegments(command).some((segment) => {
    const parsed = parseActualCommand(tokenizeShellSegment(segment));
    if (!parsed) {
      return false;
    }
    if (parsed.executable === 'bash' || parsed.executable === 'sh') {
      const commandOption = parsed.args.findIndex(
        (argument) => argument === '-c' || /^-[^-]*c/.test(argument)
      );
      const script = parsed.args[commandOption + 1];
      return (
        shellDepth < MAX_WRAPPER_DEPTH &&
        commandOption >= 0 &&
        Boolean(script) &&
        isWriteRiskCommand(script, shellDepth + 1)
      );
    }
    if (WRITE_RISK_EXECUTABLES.has(parsed.executable)) {
      return true;
    }
    if (parsed.executable === 'sed') {
      return parsed.args.some((argument) => /^-[^-]*i/.test(argument));
    }
    if (parsed.executable === 'npm' || parsed.executable === 'pnpm') {
      return parsed.args[0] === 'i' || parsed.args[0] === 'install';
    }
    if (parsed.executable === 'docker') {
      return parsed.args[0] === 'run' || parsed.args[0] === 'compose';
    }
    if (parsed.executable === 'systemctl') {
      const systemctl = systemctlCommand(parsed.args);
      return ['start', 'stop', 'restart', 'enable', 'disable'].includes(
        systemctl?.executable ?? ''
      );
    }
    return false;
  });
}

export function assessCommand(command: string): CommandAssessment {
  const trimmed = command.trim();
  if (trimmed.length > MAX_COMMAND_LENGTH) {
    return { risk: 'write', reason: '命令过长，无法安全分类为只读操作' };
  }
  if (!trimmed) {
    return { risk: 'write', reason: '空命令不能被确认为只读操作' };
  }
  if (isHighRiskCommand(trimmed)) {
    return { risk: 'high', reason: '命令可能影响系统、用户、磁盘或 SSH 访问' };
  }
  if (COMPLEX_SHELL_SYNTAX.test(trimmed)) {
    return { risk: 'write', reason: '复合 Shell 语法不能自动确认为只读操作' };
  }
  if (isWriteRiskCommand(trimmed)) {
    return { risk: 'write', reason: '命令可能修改远程服务器状态' };
  }
  if (isReadonlyCommand(trimmed)) {
    return { risk: 'readonly', reason: '命令属于明确的单条只读检查' };
  }
  return { risk: 'write', reason: '无法确认命令只读，按写操作处理' };
}

export function authorizeCommand(
  authorizationLevel: AuthorizationLevel,
  command: string
): AuthorizationDecision {
  const assessment = assessCommand(command);
  return {
    ...assessment,
    allowed:
      authorizationLevel === 'ask_every_time' ||
      (authorizationLevel === 'auto_readonly' && assessment.risk === 'readonly') ||
      (authorizationLevel === 'trusted_session' && assessment.risk !== 'high')
  };
}

export function authorizeTransfer(
  authorizationLevel: AuthorizationLevel,
  direction: 'upload' | 'download'
): AuthorizationDecision {
  const readonly = direction === 'download';
  return {
    risk: readonly ? 'readonly' : 'write',
    reason: readonly ? '下载不会修改远程服务器文件' : '上传会修改远程服务器文件',
    allowed: authorizationLevel !== 'auto_readonly' || readonly
  };
}

export function enforceCommandAuthorization(
  authorizationLevel: AuthorizationLevel,
  command: string
): void {
  const authorization = authorizeCommand(authorizationLevel, command);
  if (!authorization.allowed) {
    if (authorizationLevel === 'trusted_session') {
      throw new Error(`高危操作仍需逐次审批，请切换到“每次询问”后重试：${authorization.reason}`);
    }
    throw new Error(`当前会话为“只读自动”，已拒绝 ${authorization.risk} 操作：${authorization.reason}`);
  }
}

export function enforceTransferAuthorization(
  authorizationLevel: AuthorizationLevel,
  direction: 'upload' | 'download'
): void {
  const authorization = authorizeTransfer(authorizationLevel, direction);
  if (!authorization.allowed) {
    throw new Error(
      `当前会话为“只读自动”，已拒绝文件${direction === 'upload' ? '上传' : '下载'}：${authorization.reason}`
    );
  }
}
