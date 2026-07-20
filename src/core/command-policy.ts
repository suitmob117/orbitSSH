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
const WRITE_RISK = /\b(rm|mv|cp|chmod|chown|mkdir|touch|tee|sed\s+-i|apt|apt-get|yum|dnf|npm\s+i|pnpm\s+i|docker\s+run|docker\s+compose|systemctl\s+(start|stop|restart|enable|disable))\b/i;
const READONLY_PREFIX = /^(ls|pwd|cat|head|tail|grep|stat|df|du|free|top|ps|whoami|id|uname|uptime|systemctl\s+status)\b/i;
const COMPLEX_SHELL_SYNTAX = /(?:\r|\n|&|\|\||[;|<>`]|\$\()/;
const COMMON_EXECUTABLE_PATH = /^\/(?:usr\/)?s?bin\/([^/]+)$/i;

function stripBasicQuotes(token: string): string {
  return token.replace(/^["']+|["']+$/g, '');
}

function executableName(token: string): string | undefined {
  if (/^[\w.-]+$/.test(token)) {
    return token;
  }
  return COMMON_EXECUTABLE_PATH.exec(token)?.[1];
}

function isDestructiveRm(tokens: string[]): boolean {
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

function hasOtherHighRiskCommand(tokens: string[]): boolean {
  return tokens.some((token, index) => {
    const executable = executableName(token);
    if (!executable) {
      return false;
    }
    if (executable === 'dd') {
      return tokens.slice(index + 1).some((argument) => argument.startsWith('if='));
    }
    if (executable === 'systemctl') {
      return tokens[index + 1] === 'restart' && /^(?:ssh|sshd)$/.test(tokens[index + 2] ?? '');
    }
    return OTHER_HIGH_RISK.test(executable);
  });
}

function isHighRiskCommand(command: string): boolean {
  return command.split(/&&|\|\||[;|&]/).some((segment) => {
    const tokens = segment.trim().split(/\s+/).filter(Boolean).map(stripBasicQuotes);
    return isDestructiveRm(tokens) || hasOtherHighRiskCommand(tokens);
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
