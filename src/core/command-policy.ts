export type CommandRisk = 'readonly' | 'write' | 'high';

const HIGH_RISK = /\b(rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot|userdel|passwd|visudo|iptables|ufw|firewall-cmd|systemctl\s+restart\s+ssh|systemctl\s+restart\s+sshd)\b/i;
const WRITE_RISK = /\b(rm|mv|cp|chmod|chown|mkdir|touch|tee|sed\s+-i|apt|apt-get|yum|dnf|npm\s+i|pnpm\s+i|docker\s+run|docker\s+compose|systemctl\s+(start|stop|restart|enable|disable))\b/i;
const READONLY_PREFIX = /^(ls|pwd|cat|less|head|tail|grep|rg|find|stat|df|du|free|top|ps|whoami|id|uname|uptime|date|systemctl\s+status|journalctl)\b/i;

export function assessCommand(command: string): { risk: CommandRisk; reason: string } {
  const trimmed = command.trim();
  if (HIGH_RISK.test(trimmed)) {
    return { risk: 'high', reason: '命令可能影响系统、用户、磁盘或 SSH 访问' };
  }
  if (WRITE_RISK.test(trimmed)) {
    return { risk: 'write', reason: '命令可能修改远程服务器状态' };
  }
  if (READONLY_PREFIX.test(trimmed)) {
    return { risk: 'readonly', reason: '命令看起来是只读检查' };
  }
  return { risk: 'write', reason: '无法确认命令只读，按写操作处理' };
}
