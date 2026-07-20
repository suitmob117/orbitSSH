import type { AuthorizationLevel } from '../shared/types';

export type CommandRisk = 'readonly' | 'write' | 'high';

export interface CommandAssessment {
  risk: CommandRisk;
  reason: string;
}

export interface AuthorizationDecision extends CommandAssessment {
  allowed: boolean;
}

const OTHER_HIGH_RISK = /^(?:mkfs\b|dd\s+if=|shutdown\b|reboot\b|userdel\b|passwd\b|visudo\b|iptables\b|ufw\b|firewall-cmd\b|systemctl\s+restart\s+ssh(?:d)?\b)/i;
const WRITE_RISK = /\b(rm|mv|cp|chmod|chown|mkdir|touch|tee|sed\s+-i|apt|apt-get|yum|dnf|npm\s+i|pnpm\s+i|docker\s+run|docker\s+compose|systemctl\s+(start|stop|restart|enable|disable))\b/i;
const READONLY_PREFIX = /^(ls|pwd|cat|head|tail|grep|stat|df|du|free|top|ps|whoami|id|uname|uptime|systemctl\s+status)\b/i;
const COMPLEX_SHELL_SYNTAX = /(?:\r|\n|&|\|\||[;|<>`]|\$\()/;
const SUDO_OPTIONS_WITH_VALUE = new Set([
  '-u',
  '-g',
  '-h',
  '-p',
  '-r',
  '-t',
  '-C',
  '--user',
  '--group',
  '--host',
  '--prompt',
  '--role',
  '--type',
  '--close-from'
]);

function stripSudoPrefix(command: string): string {
  const tokens = command.split(/\s+/);
  if (tokens[0] !== 'sudo') {
    return command;
  }

  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (!token.startsWith('-')) {
      break;
    }
    index += SUDO_OPTIONS_WITH_VALUE.has(token) ? 2 : 1;
  }

  return tokens.slice(index).join(' ');
}

function isDestructiveRm(command: string): boolean {
  const tokens = command.split(/\s+/);
  const rmIndex = tokens.findIndex(
    (token) => token === 'rm' || (token.startsWith('/') && token.endsWith('/rm'))
  );
  if (rmIndex === -1) {
    return false;
  }

  let recursive = false;
  let force = false;
  for (const token of tokens.slice(rmIndex + 1)) {
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

function isHighRiskCommand(command: string): boolean {
  return command.split(/&&|\|\||[;|&]/).some((segment) => {
    const executable = stripSudoPrefix(segment.trim()).replace(/^\/(?:[\w.-]+\/)*/, '');
    return isDestructiveRm(executable) || OTHER_HIGH_RISK.test(executable);
  });
}

export function assessCommand(command: string): CommandAssessment {
  const trimmed = command.trim();
  if (!trimmed) {
    return { risk: 'write', reason: '空命令不能被确认为只读操作' };
  }
  if (isHighRiskCommand(trimmed)) {
    return { risk: 'high', reason: '命令可能影响系统、用户、磁盘或 SSH 访问' };
  }
  if (COMPLEX_SHELL_SYNTAX.test(trimmed)) {
    return { risk: 'write', reason: '复合 Shell 语法不能自动确认为只读操作' };
  }
  if (WRITE_RISK.test(trimmed)) {
    return { risk: 'write', reason: '命令可能修改远程服务器状态' };
  }
  if (READONLY_PREFIX.test(trimmed)) {
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
    allowed: authorizationLevel !== 'auto_readonly' || assessment.risk === 'readonly'
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
    throw new Error(
      `当前会话为“只读自动”，已拒绝 ${authorization.risk} 操作：${authorization.reason}`
    );
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
