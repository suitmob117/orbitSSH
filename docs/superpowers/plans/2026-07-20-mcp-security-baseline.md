# MCP 安全基线实施计划

> **面向执行代理：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，严格按任务顺序执行并逐项勾选。

**目标：** 为 AI SSH 建立可重复运行的测试基础，在 MCP 服务端真正强制执行会话授权等级，并用生产构建完成一次真实 stdio MCP 调用。

**架构：** 将授权判断集中在纯函数模块 `command-policy.ts`，SSH 会话管理器只负责在远程命令或 SFTP 开始前调用策略并拒绝未授权操作。Codex 继续负责工具调用审批，AI SSH 服务端负责不可绕过的 `auto_readonly` 边界。生产构建通过独立冒烟脚本启动并调用，避免只验证 TypeScript 编译而没有验证 MCP 协议链路。

**技术栈：** TypeScript、Node.js 22 内置测试运行器、tsx、ssh2、Model Context Protocol SDK、Electron Vite、tsup。

---

## 阶段边界

本计划只实现可以独立交付和验证的 MCP 安全基线：

- 测试运行器；
- 命令风险分类；
- `auto_readonly` 命令和文件传输强制执行；
- SSH 会话执行边界接入；
- MCP 生产构建冒烟测试；
- 中文 MCP 接入说明。

以下内容分别进入后续独立计划：

1. SQLite、JSON 迁移、SSH 主机指纹和目录访问范围；
2. 深浅双主题桌面界面与 AI 操作时间线；
3. Codex Plugin、本地 Marketplace 和一键安装诊断；
4. Windows NSIS 安装、签名更新、回滚和卸载。

## 文件职责

- `src/core/command-policy.ts`：命令风险与会话授权的唯一纯函数入口。
- `src/core/ssh-session-manager.ts`：在 SSH/SFTP 边界执行授权结果，不自行解析命令。
- `tests/command-policy.test.ts`：覆盖风险分类、复合命令和授权等级。
- `tests/redaction.test.ts`：保护历史输出的基础脱敏行为。
- `scripts/mcp-smoke.mjs`：启动生产 MCP 构建并调用真实工具。
- `package.json`：提供统一测试和 MCP 冒烟命令。
- `docs/codex-mcp-setup.md`：记录当前阶段可实际使用的中文接入和审批说明。

---

### 任务 1：建立 Node TypeScript 测试入口

**文件：**

- 修改：`package.json`
- 新建：`tests/command-policy.test.ts`

- [ ] **步骤 1：新增测试脚本**

在 `package.json` 的 `scripts` 中加入：

```json
{
  "test": "tsx --test \"tests/**/*.test.ts\"",
  "test:policy": "tsx --test tests/command-policy.test.ts"
}
```

- [ ] **步骤 2：用现有行为验证测试运行器**

新建 `tests/command-policy.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { assessCommand } from '../src/core/command-policy';

test('识别单条明确的只读命令', () => {
  assert.equal(assessCommand('ls -la').risk, 'readonly');
});
```

- [ ] **步骤 3：运行测试入口**

运行：

```powershell
npm.cmd run test:policy
```

预期：1 个测试通过，退出码为 0。

- [ ] **步骤 4：提交测试基础**

```powershell
git add package.json tests/command-policy.test.ts
git commit -m "test: add TypeScript test runner"
```

---

### 任务 2：以测试驱动实现保守命令授权

**文件：**

- 修改：`tests/command-policy.test.ts`
- 修改：`src/core/command-policy.ts`

- [ ] **步骤 1：先写授权失败测试**

把测试文件扩展为：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessCommand,
  authorizeCommand,
  authorizeTransfer
} from '../src/core/command-policy';

test('识别单条明确的只读命令', () => {
  assert.equal(assessCommand('ls -la').risk, 'readonly');
});

test('复合命令不能伪装成自动只读', () => {
  assert.equal(assessCommand('ls; python mutate.py').risk, 'write');
  assert.equal(assessCommand('ps aux | grep node').risk, 'write');
  assert.equal(assessCommand('cat $(echo /etc/passwd)').risk, 'write');
  assert.equal(assessCommand('cat file > copy').risk, 'write');
  assert.equal(assessCommand('pwd\nuname -a').risk, 'write');
});

test('空命令按写操作处理', () => {
  assert.equal(assessCommand('   ').risk, 'write');
});

test('只读自动会话只允许明确只读命令', () => {
  assert.equal(authorizeCommand('auto_readonly', 'df -h').allowed, true);
  assert.equal(authorizeCommand('auto_readonly', 'mkdir /tmp/demo').allowed, false);
  assert.equal(authorizeCommand('auto_readonly', 'ls && python mutate.py').allowed, false);
});

test('已由客户端审批的会话允许提交命令', () => {
  assert.equal(authorizeCommand('ask_every_time', 'mkdir /tmp/demo').allowed, true);
  assert.equal(authorizeCommand('trusted_session', 'mkdir /tmp/demo').allowed, true);
});

test('只读自动会话允许下载但拒绝上传', () => {
  assert.equal(authorizeTransfer('auto_readonly', 'download').allowed, true);
  assert.equal(authorizeTransfer('auto_readonly', 'upload').allowed, false);
  assert.equal(authorizeTransfer('ask_every_time', 'upload').allowed, true);
});
```

- [ ] **步骤 2：确认测试按预期失败**

运行：

```powershell
npm.cmd run test:policy
```

预期：测试因为 `authorizeCommand` 和 `authorizeTransfer` 尚未导出而失败。失败原因必须是缺少新授权接口，不是测试语法错误。

- [ ] **步骤 3：实现最小授权模块**

将 `src/core/command-policy.ts` 修改为：

```ts
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
const COMPLEX_SHELL_SYNTAX = /(?:\r|\n|&&|\|\||[;|<>`]|\$\()/;

export function assessCommand(command: string): CommandAssessment {
  const trimmed = command.trim();
  if (!trimmed) {
    return { risk: 'write', reason: '空命令不能被确认为只读操作' };
  }
  if (HIGH_RISK.test(trimmed)) {
    return { risk: 'high', reason: '命令可能影响系统、用户、磁盘或 SSH 访问' };
  }
  if (WRITE_RISK.test(trimmed)) {
    return { risk: 'write', reason: '命令可能修改远程服务器状态' };
  }
  if (COMPLEX_SHELL_SYNTAX.test(trimmed)) {
    return { risk: 'write', reason: '复合 Shell 语法不能自动确认为只读操作' };
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
```

- [ ] **步骤 4：确认策略测试转绿**

运行：

```powershell
npm.cmd run test:policy
```

预期：全部策略测试通过，退出码为 0。

- [ ] **步骤 5：运行类型检查**

运行：

```powershell
npm.cmd run typecheck
```

预期：退出码为 0，无 TypeScript 错误。

- [ ] **步骤 6：提交策略实现**

```powershell
git add src/core/command-policy.ts tests/command-policy.test.ts
git commit -m "fix: enforce conservative command authorization"
```

---

### 任务 3：在 SSH 和 SFTP 边界强制执行策略

**文件：**

- 修改：`tests/command-policy.test.ts`
- 修改：`src/core/command-policy.ts`
- 修改：`src/core/ssh-session-manager.ts`

- [ ] **步骤 1：先写拒绝异常测试**

在策略测试的导入中加入：

```ts
import {
  assessCommand,
  authorizeCommand,
  authorizeTransfer,
  enforceCommandAuthorization,
  enforceTransferAuthorization
} from '../src/core/command-policy';
```

并新增：

```ts
test('执行边界对只读自动写命令抛出明确错误', () => {
  assert.throws(
    () => enforceCommandAuthorization('auto_readonly', 'mkdir /tmp/demo'),
    /当前会话为“只读自动”/
  );
  assert.doesNotThrow(() => enforceCommandAuthorization('auto_readonly', 'df -h'));
});

test('执行边界对只读自动上传抛出明确错误', () => {
  assert.throws(
    () => enforceTransferAuthorization('auto_readonly', 'upload'),
    /已拒绝文件上传/
  );
  assert.doesNotThrow(() => enforceTransferAuthorization('auto_readonly', 'download'));
});
```

- [ ] **步骤 2：确认执行边界测试按预期失败**

运行：

```powershell
npm.cmd run test:policy
```

预期：测试因为两个 `enforce*` 函数尚未导出而失败。

- [ ] **步骤 3：实现抛错边界函数**

在 `src/core/command-policy.ts` 中加入：

```ts
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
```

- [ ] **步骤 4：确认执行边界测试转绿**

运行：

```powershell
npm.cmd run test:policy
```

预期：全部策略测试通过。

- [ ] **步骤 5：在会话管理器接入命令授权判断**

把导入改为：

```ts
import {
  assessCommand,
  enforceCommandAuthorization,
  enforceTransferAuthorization
} from './command-policy';
```

在 `runCommand` 中、创建 `startedAt` 和调用 `execRaw` 之前加入：

```ts
enforceCommandAuthorization(managed.session.authorizationLevel, command);
```

- [ ] **步骤 6：在会话管理器接入文件传输授权判断**

在 `transferFile` 中、创建 `startedAt` 和调用 `managed.client.sftp` 之前加入：

```ts
enforceTransferAuthorization(
  managed.session.authorizationLevel,
  request.direction
);
```

- [ ] **步骤 7：运行策略测试和类型检查**

运行：

```powershell
npm.cmd run test:policy
npm.cmd run typecheck
```

预期：两条命令均以退出码 0 完成。

- [ ] **步骤 8：提交执行边界改动**

```powershell
git add src/core/command-policy.ts src/core/ssh-session-manager.ts tests/command-policy.test.ts
git commit -m "fix: enforce authorization at SSH boundaries"
```

---

### 任务 4：锁定基础脱敏行为

**文件：**

- 新建：`tests/redaction.test.ts`

- [ ] **步骤 1：新增脱敏回归测试**

新建 `tests/redaction.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { redact, tail } from '../src/core/redaction';

test('脱敏常见密码和 Token', () => {
  const input = 'password=hunter2 token:abc123 api_key=secret-value';
  const output = redact(input);
  assert.equal(output.includes('hunter2'), false);
  assert.equal(output.includes('abc123'), false);
  assert.equal(output.includes('secret-value'), false);
  assert.equal(output.match(/\[REDACTED\]/g)?.length, 3);
});

test('脱敏完整私钥块', () => {
  const input = '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----';
  assert.equal(redact(input), '[REDACTED]');
});

test('截断前先脱敏', () => {
  const output = tail('prefix password=hidden-value suffix', 24);
  assert.equal(output.includes('hidden-value'), false);
});
```

- [ ] **步骤 2：确认私钥脱敏测试按预期失败**

运行：

```powershell
npm.cmd test
```

预期：私钥测试失败，因为现有统一替换字符串不能正确处理没有捕获组的私钥正则；其他脱敏测试通过。

- [ ] **步骤 3：为不同敏感模式使用明确替换规则**

将 `src/core/redaction.ts` 中的模式和 `redact` 改为：

```ts
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /(password\s*[=:]\s*)[^\s'"`]+/gi, replacement: '$1[REDACTED]' },
  { pattern: /(token\s*[=:]\s*)[^\s'"`]+/gi, replacement: '$1[REDACTED]' },
  { pattern: /(api[_-]?key\s*[=:]\s*)[^\s'"`]+/gi, replacement: '$1[REDACTED]' },
  { pattern: /(secret\s*[=:]\s*)[^\s'"`]+/gi, replacement: '$1[REDACTED]' },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED]'
  }
];

export function redact(value: string): string {
  return SECRET_PATTERNS.reduce(
    (text, { pattern, replacement }) => text.replace(pattern, replacement),
    value
  );
}
```

- [ ] **步骤 4：运行全量测试**

运行：

```powershell
npm.cmd test
```

预期：命令策略与脱敏测试全部通过，退出码为 0。

- [ ] **步骤 5：提交脱敏修复和测试**

```powershell
git add src/core/redaction.ts tests/redaction.test.ts
git commit -m "fix: cover sensitive output redaction"
```

---

### 任务 5：增加生产 MCP 冒烟测试

**文件：**

- 新建：`scripts/mcp-smoke.mjs`
- 修改：`package.json`

- [ ] **步骤 1：编写真实 stdio MCP 调用脚本**

新建 `scripts/mcp-smoke.mjs`：

```js
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dataDir = await mkdtemp(path.join(tmpdir(), 'ai-ssh-mcp-smoke-'));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve('dist/mcp/server.js')],
  cwd: process.cwd(),
  env: { ...process.env, AI_SSH_DATA_DIR: dataDir },
  stderr: 'inherit'
});
const client = new Client({ name: 'ai-ssh-smoke', version: '1.0.0' });

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: 'list_connection_profiles',
    arguments: {}
  });
  const profiles = JSON.parse(result.content[0].text);
  if (!Array.isArray(profiles)) {
    throw new Error('list_connection_profiles 没有返回数组');
  }
  process.stdout.write(`MCP 冒烟测试通过：${profiles.length} 个连接配置\n`);
} finally {
  await client.close();
  await rm(dataDir, { recursive: true, force: true });
}
```

- [ ] **步骤 2：新增冒烟脚本入口**

在 `package.json` 的 `scripts` 中加入：

```json
{
  "mcp:smoke": "node scripts/mcp-smoke.mjs"
}
```

- [ ] **步骤 3：构建并执行真实 MCP 调用**

运行：

```powershell
npm.cmd run build
npm.cmd run mcp:smoke
```

预期：构建退出码为 0，随后输出 `MCP 冒烟测试通过：0 个连接配置`。

- [ ] **步骤 4：提交冒烟测试**

```powershell
git add package.json scripts/mcp-smoke.mjs
git commit -m "test: add production MCP smoke test"
```

---

### 任务 6：更新中文 MCP 接入说明并做阶段验收

**文件：**

- 修改：`docs/codex-mcp-setup.md`

- [ ] **步骤 1：把接入文档改为当前可执行的中文说明**

文档必须明确：

- 先运行 `npm.cmd run build`；
- MCP 入口是绝对路径 `D:\\Code\\ai-ssh\\dist\\mcp\\server.js`；
- Codex 使用 `codex mcp add ai_ssh -- node <绝对路径>` 注册；
- `list_connection_profiles` 和 `get_session_health` 是只读工具；
- 打开会话、命令执行、上传、下载和关闭会话保留人工审批；
- `auto_readonly` 在服务端拒绝写命令和上传；
- 本阶段还是开发目录接入，正式 Plugin 和一键安装属于后续计划。

- [ ] **步骤 2：运行完整阶段验证**

依次运行：

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run mcp:smoke
git diff --check
```

预期：所有命令退出码均为 0；测试无失败；生产构建成功；MCP 冒烟调用成功；Git 差异没有空白错误。

- [ ] **步骤 3：核对计划要求**

逐项确认：

- `auto_readonly` 明确只读命令通过；
- 复合命令、写命令和上传被服务端拒绝；
- 下载仍可执行；
- 其他授权等级保持可用；
- 生产 MCP 构建可以被真实客户端启动并调用；
- 中文文档与实际命令一致。

- [ ] **步骤 4：提交阶段文档**

```powershell
git add docs/codex-mcp-setup.md
git commit -m "docs: update Chinese Codex MCP setup"
```

---

## 完成定义

只有在任务 6 的完整验证全部通过后，本阶段才算完成。不得仅以类型检查、单个测试或构建成功代替 MCP 真实调用验证。
