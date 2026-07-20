import type { AuthorizationLevel } from '../shared/types';

export type CommandRisk = 'readonly' | 'write' | 'high';

export interface CommandAssessment {
  risk: CommandRisk;
  reason: string;
}

export interface AuthorizationDecision extends CommandAssessment {
  allowed: boolean;
}

const HIGH_RISK = /\b(rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot|userdel|passwd|visudo|iptables|ufw|firewall-cmd|systemctl\s+restart\s+ssh|systemctl\s+restart\s+sshd)\b/i;
const WRITE_RISK = /\b(rm|mv|cp|chmod|chown|mkdir|touch|tee|sed\s+-i|apt|apt-get|yum|dnf|npm\s+i|pnpm\s+i|docker\s+run|docker\s+compose|systemctl\s+(start|stop|restart|enable|disable))\b/i;
const READONLY_PREFIX = /^(ls|pwd|cat|less|head|tail|grep|rg|find|stat|df|du|free|top|ps|whoami|id|uname|uptime|date|systemctl\s+status|journalctl)\b/i;
const COMPLEX_SHELL_SYNTAX = /(?:\r|\n|&|\|\||[;|<>`]|\$\()/;

export function assessCommand(command: string): CommandAssessment {
  const trimmed = command.trim();
  if (!trimmed) {
    return { risk: 'write', reason: '空命令不能被确认为只读操作' };
  }
  if (COMPLEX_SHELL_SYNTAX.test(trimmed)) {
    return { risk: 'write', reason: '复合 Shell 语法不能自动确认为只读操作' };
  }
  if (HIGH_RISK.test(trimmed)) {
    return { risk: 'high', reason: '命令可能影响系统、用户、磁盘或 SSH 访问' };
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
