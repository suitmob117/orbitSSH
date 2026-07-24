# OrbitSSH 人机共驾 Runtime 实施设计

> 日期：2026-07-24  
> 基线：`codex/data-boundaries`  
> 目标：把“桌面 SSH + 独立 MCP”迁移为“一个执行核心、两个驾驶入口”。

## 一、评审结论

现有架构草案的产品方向正确：真正的共驾必须共享 SSH、PTY、执行队列和审批状态，而不是只把两个进程的历史拼到一起。

实施时需要坚持四个修正：

1. “每次询问 / 自动只读 / 信任会话”是三档 Codex 授权等级；“完全接管 / Codex 接入”是另一条状态轴，不增加第四档。
2. 用户与 Codex 默认共享同一个先进先出命令队列，普通用户输入不改变 Codex 接入状态；开启“完全接管”后阻止未启动的 Codex 动作，正在运行的前台命令必须由用户明确中断，不能静默抢占。
3. 原始交互 PTY 无法可靠预判所有回车。强制数据护栏对双方生效，结构化 Codex 命令始终预检，用户高危命令则在受保护命令模式预检；首版只支持普通单行命令，后续进入原始 TTY 时必须明确提示并要求用户主动完全接管。
4. Electron 退出不能拥有或销毁 SSH 会话。只有独立 Runtime Host 能满足“关闭界面后 Codex 继续”。

## 二、目标进程模型

```text
Electron Renderer
       │ IPC
Electron Main ───────────────┐
                             │ Named Pipe（当前 Windows 用户）
Codex ─ MCP stdio ─ MCP Adapter ─┤
                             ▼
                  OrbitSSH Runtime Host
                  ├─ CodrivingCoordinator
                  ├─ SshSessionManager / PTY
                  ├─ FileBoundary / SFTP
                  ├─ RuntimeLifetime
                  └─ SQLite Event Ledger
```

Runtime Host 是唯一创建 `SshSessionManager` 的进程。Electron 与 MCP 不再直接创建 SSH Socket。

## 三、协调模块接口

外部适配器只需要以下能力：

- `requestCommand`：提交用户或 Codex 命令；
- `requestFileTransfer`：提交有文件范围约束的上传下载；
- `approveAction / rejectAction`：处理绑定摘要的待审批动作；
- `pauseCodex / resumeCodex`：开启完全接管和恢复 Codex 接入；
- `setAuthorizationLevel`：设置本次会话的三档授权和信任有效期；
- `listEvents(sessionId, afterSequence)`：按事件游标补回共驾轨迹。

SSH 执行、排队、风险评估、审批过期和脱敏全部隐藏在模块内部。MCP 不暴露批准接口，防止 Codex 自批。

## 四、会话状态机

```text
disconnected
   │ connect
   ▼
ready ── Codex request ──> pending_approval ── approve ──> running
  │                              │ reject/expire              │
  │ user takeover               └──────────────> rejected     │
  ▼                                                         complete/fail
codex_paused <──────── resume ─────────────────────────────── ready
```

规则：

- 同一共享终端同一时刻只有一个前台动作；
- 用户和 Codex 命令进入同一个先进先出队列，普通用户输入不自动暂停 Codex；
- 完全接管会阻止新提交及已排队未启动的 Codex 操作，但不会静默中断正在运行的命令；
- 待审批动作冻结同一会话后续 Codex 队列；
- 其他连接会话可以继续；
- 用户普通结构化命令不受 Codex 授权等级限制；
- 用户与 Codex 的高危结构化命令都要审批；
- 审批绑定会话、完整动作内容和有效期，展示内容先脱敏；
- 信任到期自动降级为每次询问。

## 五、界面退出和后台保活

Runtime 维护四类租约：`desktop`、`mcp`、`active_action`、`retained_session`。

关闭桌面端时：

- “仅关闭界面，Codex 继续”：释放 `desktop`，保留共享会话；
- “任务完成后关闭”：活动动作和待审批超时处理完成后关闭；
- “立即关闭全部能力”：拒绝待审批动作、中断允许中断的动作并关闭所有会话。

无界面时遇到高危动作：

- 动作停在待审批，尚未写入 SSH；
- 同一会话 Codex 队列暂停；
- MCP 返回等待用户，Windows 发脱敏通知；
- 用户重开客户端后按逻辑会话 ID 和事件游标恢复审批；
- 30 分钟未处理自动过期拒绝。

## 六、Named Pipe 协议

协议采用长度限制的 JSON 消息，不允许任意方法名透传。

每个连接先完成：

1. 协议版本握手；
2. 当前 Windows 用户身份校验；
3. 客户端种类登记；
4. 租约创建。

请求包含 `requestId`、固定方法枚举和经过 Zod 校验的参数。事件包含单调递增 `sequence`，客户端重连时用 `afterSequence` 补回。终端字节流使用独立事件类型并限制单帧大小，不能混入请求通道执行任意代码。

## 七、事件账本

SQLite `session_events` 至少保存：

- 事件序号和逻辑会话 ID；
- 发起者：用户、Codex、系统；
- 动作种类、风险、状态和脱敏摘要；
- 审批摘要、有效期和处理结果；
- 开始、完成、失败、拒绝或过期时间。

原始密码、Token、Cookie 和私钥内容不进入账本。完整待执行动作只保存在 Runtime 的受控待审批区；重启恢复若不能安全恢复原动作，则标记为已中断，不自动重放写操作。

## 八、分阶段交付

### 阶段 1：协调核心（已实现）

- 三档授权真实执行；
- 用户/Codex 来源标记；
- 审批摘要绑定和过期；
- 高危共享护栏；
- 共享先进先出队列、完全接管和恢复 Codex 接入；
- 待审批冻结同会话队列；
- 单调事件序号；
- Runtime 租约状态机；
- 协调模块保持在生产入口之外，避免在 Runtime Host 尚未共享前形成无法由桌面端处理的跨进程待审批；Electron 与 MCP 将在阶段 2 同时切换。

### 阶段 2：独立 Runtime Host

- 建立 Named Pipe Server/Client；
- 把 `createCoreServices` 移到 Runtime Host；
- Electron 与 MCP 改为 Runtime 客户端；
- 终端数据和会话事件通过订阅推送；
- 加入单实例、身份校验、版本握手和进程保活。

### 阶段 3：持久事件与后台审批

- 建立 `logical_sessions`、`session_events`、`runtime_leases`、`approvals`；
- UI 按事件游标重连；
- Windows 脱敏通知；
- 审批到期定时器和退出策略。

### 阶段 4：共驾界面

- 连接前集中显示目标、三档授权和文件范围；
- 连接后移除重复状态卡；
- 右侧只展示动态共驾轨迹和审批；
- 增加完全接管开关、Codex 接入状态和后台保活选择；
- 文件舱只展示目录、范围和传输状态。

### 阶段 5：跨 Runtime 恢复（可选）

- 逻辑会话恢复；
- 只读动作安全重试；
- 可选 `tmux`/`screen` 适配器，用于跨 Runtime 或电脑重启保留远程交互进程。

## 九、完成标准

- Electron 与 MCP 使用同一个 Runtime 会话；
- 关闭界面选择 Codex 继续后，SSH/PTY 与任务保持运行；
- 重开界面恢复原会话、终端与审批；
- 无界面高危操作不执行、不自批并会过期拒绝；
- 用户与 Codex 默认都能提交命令，普通输入不会自动暂停 Codex；
- 用户可以随时拒绝、明确中断，并通过完全接管阻止 Codex 后续操作；
- 所有结构化操作通过同一风险、审批、文件范围和脱敏链；
- 连接、授权、文件范围和风险状态不在多个区域重复。
