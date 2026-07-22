# 数据持久化与连接边界实施计划

> **供自动化实施使用：** 实施时必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，并通过复选框（`- [ ]`）逐项跟踪。

**目标：** 将连接配置和历史从 JSON 安全迁移到启用 WAL 的 SQLite，并在 SSH 指纹及 SFTP 文件路径上实施不可绕过的安全边界。

**架构：** 新建 SQLite 基础设施层处理建表、WAL、事务迁移和 JSON 回退；ProfileStore、HistoryStore 和 HostKeyStore 都只经由该层访问持久数据。SSH 会话在握手阶段验证指纹，SFTP 在调用前验证本地和远程目录范围。

**技术栈：** TypeScript、Electron、Node.js、better-sqlite3、ssh2、node:test、Windows 凭据管理器。

---

## 文件结构

- 新建：`src/core/sqlite-store.ts` — WAL、schema、迁移状态与 JSON 回退。
- 新建：`src/core/host-key-store.ts` — SSH SHA-256 指纹的首次信任、查询与替换。
- 新建：`src/core/file-boundary.ts` — 本地真实路径及 POSIX 远程路径范围验证。
- 修改：`src/core/paths.ts`、`src/core/profile-store.ts`、`src/core/history-store.ts`、`src/core/services.ts`、`src/core/ssh-session-manager.ts`。
- 修改：`src/shared/types.ts`、`src/shared/validation.ts`、`src/main/index.ts`、`src/preload/index.ts`、`src/renderer/src/App.tsx`、`src/mcp/server.ts`。
- 测试：`tests/sqlite-store.test.ts`、`tests/profile-store.test.ts`、`tests/host-key-store.test.ts`、`tests/file-boundary.test.ts`、`tests/ssh-session-manager.test.ts`。

### 任务 1：SQLite 数据库与可恢复迁移

**文件：**
- 新建：`src/core/sqlite-store.ts`
- 修改：`src/core/paths.ts`、`package.json`、`package-lock.json`
- 测试：`tests/sqlite-store.test.ts`

- [x] **步骤 1：写出失败的迁移测试**

```ts
test('migrates legacy JSON atomically and retains read-only backups', async () => {
  await writeFile(join(dataDir, 'profiles.json'), JSON.stringify([legacyProfile]));
  await writeFile(join(dataDir, 'history.json'), JSON.stringify([legacyRecord]));
  const store = new SqliteStore(dataDir);
  assert.equal(store.listProfiles().length, 1);
  assert.equal(store.listHistory().length, 1);
  assert.equal(await stat(join(dataDir, 'profiles.json.bak')).then(() => true), true);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`npm.cmd test -- tests/sqlite-store.test.ts`
预期：失败，并提示 `SqliteStore` 未定义。

- [x] **步骤 3：实现 WAL、schema 和迁移失败回退**

```ts
this.db.pragma('journal_mode = WAL');
this.db.exec('BEGIN IMMEDIATE');
try {
  this.importLegacyJson();
  this.verifyImport();
  this.db.exec('COMMIT');
  await rename(source, `${source}.bak`);
} catch (error) {
  this.db.exec('ROLLBACK');
  throw error;
}
```

建 `profiles`、`command_history`、`host_keys` 表。JSON 解析、插入或校验失败时关闭数据库、保留两个 JSON 文件，并让上层继续使用 JsonStore。

- [x] **步骤 4：运行测试确认通过**

运行：`npm.cmd test -- tests/sqlite-store.test.ts`
预期：通过。

- [x] **步骤 5：准备提交**

```bash
git add package.json package-lock.json src/core/paths.ts src/core/sqlite-store.ts tests/sqlite-store.test.ts
git commit -m "feat: add recoverable SQLite data migration"
```

### 任务 2：配置和历史持久化

**文件：**
- 修改：`src/core/profile-store.ts`、`src/core/history-store.ts`、`src/core/services.ts`
- 测试：`tests/profile-store.test.ts`

- [x] **步骤 1：写出失败的秘密排除与保留测试**

```ts
test('stores only credential references in SQLite', async () => {
  const profile = await profiles.save({ ...input, password: 'never-in-sqlite' });
  assert.equal(db.readText().includes('never-in-sqlite'), false);
  assert.equal(profile.credentialId, credentialId(profile.id, 'password'));
});

test('keeps only the latest 500 history records', async () => {
  for (let index = 0; index < 501; index += 1) await history.append(record(index));
  assert.equal((await history.list()).length, 500);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`npm.cmd test -- tests/profile-store.test.ts`
预期：失败，当前 JSON 实现不会创建 SQLite 行。

- [x] **步骤 3：只保存安全字段**

```ts
this.database.saveProfile(profile);
this.database.appendHistory(commandRecord, MAX_RECORDS);
```

ProfileStore 保留 CredentialVault 调用；SQLite 仅保存 `credential_id`、`private_key_passphrase_credential_id` 等凭据引用，不保存密码或私钥口令。数据库不可用时两个 store 共用 JsonStore 回退。

- [x] **步骤 4：运行相关测试**

运行：`npm.cmd test -- tests/profile-store.test.ts tests/sqlite-store.test.ts`
预期：通过。

- [x] **步骤 5：准备提交**

```bash
git add src/core/profile-store.ts src/core/history-store.ts src/core/services.ts tests/profile-store.test.ts
git commit -m "feat: persist profiles and history in SQLite"
```

### 任务 3：SSH 主机指纹首次信任与变化阻断

**文件：**
- 新建：`src/core/host-key-store.ts`
- 修改：`src/core/ssh-session-manager.ts`、`src/shared/types.ts`、`src/main/index.ts`、`src/preload/index.ts`、`src/renderer/src/App.tsx`
- 测试：`tests/host-key-store.test.ts`、`tests/ssh-session-manager.test.ts`

- [x] **步骤 1：写出失败的指纹策略测试**

```ts
test('accepts first key once and blocks a changed key before ready', async () => {
  await manager.openSession('profile-1', 'ask_every_time');
  fakeClient.presentHostKey(Buffer.from('first'));
  await assert.rejects(manager.openSession('profile-1', 'ask_every_time'), /主机指纹已变化/);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`npm.cmd test -- tests/host-key-store.test.ts tests/ssh-session-manager.test.ts`
预期：失败，`hostVerifier` 尚未配置。

- [x] **步骤 3：实现指纹记录和 GUI 人工替换**

```ts
hostVerifier: (key) => {
  const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64')}`;
  return this.hostKeys.verifyOrTrustFirst(profile.id, profile.host, profile.port, fingerprint);
}
```

首次指纹仅在 GUI 明确确认时持久化；MCP 对未知或变化指纹一律失败。变化时返回旧/新 SHA-256 和风险说明，只有 GUI `replaceHostKeyTrust` IPC 可以更新记录。

- [x] **步骤 4：运行指纹测试**

运行：`npm.cmd test -- tests/host-key-store.test.ts tests/ssh-session-manager.test.ts`
预期：通过。

- [x] **步骤 5：准备提交**

```bash
git add src/core/host-key-store.ts src/core/ssh-session-manager.ts src/shared/types.ts src/main/index.ts src/preload/index.ts src/renderer/src/App.tsx tests/host-key-store.test.ts tests/ssh-session-manager.test.ts
git commit -m "feat: verify SSH host fingerprints"
```

### 任务 4：文件传输目录边界

**文件：**
- 新建：`src/core/file-boundary.ts`
- 修改：`src/shared/types.ts`、`src/shared/validation.ts`、`src/core/ssh-session-manager.ts`、`src/mcp/server.ts`
- 测试：`tests/file-boundary.test.ts`、`tests/ssh-session-manager.test.ts`

- [x] **步骤 1：写出失败的路径逃逸测试**

```ts
test('rejects local traversal, symlink escape, case bypass and remote traversal', async () => {
  await assert.rejects(boundary.localUpload(join(root, '..', 'secret.txt')), /允许目录/);
  await assert.rejects(boundary.localUpload(join(root, 'escape-link', 'secret.txt')), /允许目录/);
  assert.throws(() => boundary.remote('/srv/app/../secret.txt'), /允许目录/);
});
```

- [x] **步骤 2：运行测试确认失败**

运行：`npm.cmd test -- tests/file-boundary.test.ts`
预期：失败，当前 SFTP 直接使用调用方路径。

- [x] **步骤 3：实现本地真实路径与远程 POSIX 路径检查**

```ts
const candidate = await realpath(localPath);
const root = await realpath(allowedRoot);
if (!isContained(root, candidate, process.platform === 'win32')) throw new Error('文件路径不在允许目录内');
const remote = posix.normalize(remotePath);
if (!allowedRemoteRoots.some((root) => isRemoteContained(root, remote))) throw new Error('远程路径不在允许目录内');
```

上传和下载在 `sftp.fastPut/fastGet` 前执行。下载目标验证父目录，拒绝父目录不存在与符号链接逃逸。

- [x] **步骤 4：运行路径与会话测试**

运行：`npm.cmd test -- tests/file-boundary.test.ts tests/ssh-session-manager.test.ts`
预期：通过。

- [x] **步骤 5：提交**

```bash
git add src/core/file-boundary.ts src/shared/types.ts src/shared/validation.ts src/core/ssh-session-manager.ts src/mcp/server.ts tests/file-boundary.test.ts tests/ssh-session-manager.test.ts
git commit -m "feat: enforce SFTP directory boundaries"
```

### 任务 5：端到端回归和中文说明

**文件：**
- 修改：`docs/codex-mcp-setup.md`、`docs/superpowers/specs/2026-07-20-codex-mcp-integration-design.md`
- 测试：`tests/**/*.test.ts`

- [x] **步骤 1：增加中文运维说明**

写明 SQLite 位置、WAL 文件、JSON `.bak` 只读备份、迁移失败 JSON 回退、MCP 对未知/变化指纹的拒绝行为，以及本地/远程允许目录配置规则。

- [x] **步骤 2：运行全量验证**

运行：`npm.cmd test && npm.cmd run typecheck && npm.cmd run build && npm.cmd run mcp:smoke`
预期：所有测试通过，类型检查、生产构建和 stdio 冒烟均成功。

- [x] **步骤 3：最终审查并提交**

```bash
git diff --check
git status --short
git add docs tests src package.json package-lock.json
git commit -m "docs: document data and SSH trust boundaries"
```

## 自检结果

- 规格覆盖：任务 1–2 覆盖 SQLite、WAL、迁移、备份、失败回退和秘密不落盘；任务 3 覆盖首次信任与变化阻断；任务 4 覆盖 `..`、符号链接、大小写和本地/远程路径；任务 5 覆盖中文文档与构建验收。
- 占位扫描：无 `TODO`、`TBD` 或不可执行步骤。
- 类型一致性：`SqliteStore` 为 ProfileStore、HistoryStore、HostKeyStore 的唯一数据源；`hostVerifier` 由 `SshSessionManager` 绑定，路径检查由 `FileBoundary` 在 SFTP 调用前执行。
