import { useEffect, useMemo, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import {
  Activity,
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  FileClock,
  FileDown,
  FileText,
  FileUp,
  Folder,
  FolderUp,
  History,
  Link2,
  Monitor,
  Moon,
  RefreshCw,
  ScanLine,
  Save,
  Search,
  Server,
  Settings2,
  Sun,
  TerminalSquare,
  Upload
} from 'lucide-react';
import type {
  AuthMethod,
  AuthorizationLevel,
  CodrivingAction,
  CommandRecord,
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectionSession,
  HostKeyTrustChallenge,
  LocalFileSelection,
  RemoteFileEntry
} from '@shared/types';
import { Button, DangerButton, Input, Label, SecondaryButton, Select } from './ui';
import { SessionHeader } from './session-header';
import { cn } from '../lib/utils';
import { getCommandActivityState, takeRecentChronological } from '../lib/activity';
import { TerminalCommandTracker } from '../lib/terminal-command-tracker';
import {
  formatFileSize,
  getRemoteParent,
  isRemotePathWithinRoots,
  normalizeRemotePath
} from '../lib/remote-path';
import type { ThemePreference } from '../lib/theme';

export type CenterView = 'terminal' | 'config' | 'history';
export type InspectorView = 'activity' | 'transfer';

const AUTH_LABELS: Record<AuthMethod, string> = {
  saved_password: '保存密码',
  password_prompt: '每次输入密码',
  ssh_agent: 'SSH Agent',
  private_key: '私钥'
};

const ENABLED_AUTH_METHODS: AuthMethod[] = ['saved_password', 'ssh_agent', 'private_key'];

function healthLabel(health?: ConnectionSession['health']): string {
  if (health === 'connected') return '已连接';
  if (health === 'degraded') return '连接异常';
  if (health === 'disconnected') return '已断开';
  return '未连接';
}

function formatTime(value?: string): string {
  if (!value) return '尚未检查';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
}

function formatFileTime(value?: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function ThemeButton({
  active,
  label,
  children,
  onClick
}: {
  active: boolean;
  label: string;
  children: React.ReactNode;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn('topbar-icon', active && 'is-active')}
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function AppTopbar({
  profileName,
  themePreference,
  onThemeChange
}: {
  profileName?: string;
  themePreference: ThemePreference;
  onThemeChange: (value: ThemePreference) => void;
}): JSX.Element {
  return (
    <header className="workbench-topbar">
      <div className="workbench-brand">
        <div className="workbench-brand-mark"><img src="/icon.png" alt="" /></div>
        <div><strong>OrbitSSH</strong><span>COLLABORATIVE TERMINAL</span></div>
      </div>
      <div className="workbench-crumb">
        <span>工作空间</span><i>/</i><span>连接会话</span><i>/</i>
        <b>{profileName ?? '新建连接'}</b>
      </div>
      <div className="workbench-top-actions">
        <span className="mcp-ready"><i />本地 MCP 已就绪</span>
        <ThemeButton active={themePreference === 'system'} label="跟随系统" onClick={() => onThemeChange('system')}>
          <Monitor />
        </ThemeButton>
        <ThemeButton active={themePreference === 'light'} label="浅色主题" onClick={() => onThemeChange('light')}>
          <Sun />
        </ThemeButton>
        <ThemeButton active={themePreference === 'dark'} label="深色主题" onClick={() => onThemeChange('dark')}>
          <Moon />
        </ThemeButton>
        <ThemeButton active={themePreference === 'green'} label="复古绿屏主题" onClick={() => onThemeChange('green')}>
          <ScanLine />
        </ThemeButton>
      </div>
    </header>
  );
}

export function ServerSidebar({
  profiles,
  sessions,
  selectedProfileId,
  busy,
  onCreate,
  onSelect,
  onImport,
  onExport
}: {
  profiles: ConnectionProfile[];
  sessions: ConnectionSession[];
  selectedProfileId?: string;
  busy: boolean;
  onCreate: () => void;
  onSelect: (profile: ConnectionProfile) => void;
  onImport: () => void;
  onExport: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const filteredProfiles = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return profiles;
    return profiles.filter((profile) =>
      [profile.name, profile.host, profile.username].some((value) => value.toLowerCase().includes(keyword))
    );
  }, [profiles, query]);
  const connectedCount = profiles.filter((profile) =>
    sessions.some((session) => session.profileId === profile.id && session.health !== 'disconnected')
  ).length;

  return (
    <aside className="server-sidebar workbench-panel">
      <div className="server-sidebar-head">
        <div><span>NETWORK ATLAS</span><strong>服务器星图</strong></div>
        <div className="profile-actions">
          <button type="button" disabled={busy} onClick={onImport} aria-label="导入服务器配置" title="导入服务器配置"><FileDown /></button>
          <button type="button" disabled={busy || profiles.length === 0} onClick={onExport} aria-label="导出服务器配置" title="导出服务器配置"><FileUp /></button>
          <button type="button" disabled={busy} onClick={onCreate} aria-label="新建连接" title="新建连接">+</button>
        </div>
      </div>
      <label className="server-search">
        <Search />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索主机、用户或 IP" />
      </label>
      <div className="server-summary">
        <span className="is-active">全部 {profiles.length}</span>
        <span>在线 {connectedCount}</span>
      </div>
      <div className="server-list">
        <div className="server-group"><span>已保存连接</span><span>{String(filteredProfiles.length).padStart(2, '0')}</span></div>
        {filteredProfiles.map((profile) => {
          const session = sessions.find(
            (item) => item.profileId === profile.id && item.health !== 'disconnected'
          );
          return (
            <button
              type="button"
              key={profile.id}
              className={cn(
                'server-row',
                selectedProfileId === profile.id && 'is-selected',
                session && 'is-connected',
                session?.health === 'degraded' && 'is-degraded'
              )}
              onClick={() => onSelect(profile)}
            >
              <i className={cn('server-node', session?.health === 'connected' && 'is-online', session?.health === 'degraded' && 'is-warning')} />
              <span className="server-row-main">
                <span className="server-row-name"><b>{profile.name}</b><em>{healthLabel(session?.health)}</em></span>
                <span className="server-row-meta">{profile.username} · {profile.host} · {profile.port}</span>
              </span>
            </button>
          );
        })}
        {filteredProfiles.length === 0 ? <div className="server-empty">没有匹配的服务器</div> : null}
      </div>
      <div className="server-sidebar-foot">
        <div><strong>Codex 协作通道</strong><span className="channel-switch is-on" role="status" aria-label="Codex 协作通道已开启" title="协作通道已开启" /></div>
        <p><i />按需运行 · 数据保存在本机</p>
      </div>
    </aside>
  );
}

function TerminalPanel({
  session,
  active,
  onCommandRecorded
}: {
  session: ConnectionSession;
  active: boolean;
  onCommandRecorded: (record: CommandRecord) => void;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal>();
  const fitAddonRef = useRef<FitAddon>();
  const terminalIdRef = useRef<string>();

  const terminalTheme = () => {
    if (document.documentElement.classList.contains('green')) {
      return { background: '#020702', foreground: '#91ae86', cursor: '#b5d29f', selectionBackground: '#294029' };
    }
    return document.documentElement.classList.contains('dark')
      ? { background: '#061014', foreground: '#b9d2cf', cursor: '#62eee0', selectionBackground: '#24514f' }
      : { background: '#f5fbfa', foreground: '#244947', cursor: '#0b9e95', selectionBackground: '#b7e9e3' };
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
      fontSize: 16,
      fontWeight: 500,
      fontWeightBold: 700,
      lineHeight: 1.55,
      theme: terminalTheme()
    });
    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();
    terminal.writeln('\x1b[38;2;98;238;224m正在打开共享原始终端…\x1b[0m');
    terminal.writeln('\x1b[38;2;226;153;62m提示：你的键盘输入将直接发送到服务器，并自动暂停 Codex 后续操作。\x1b[0m');
    terminalRef.current = terminal;
    let disposed = false;
    const unsubscribe = window.aiSsh.onTerminalData((chunk) => {
      if (chunk.terminalId === terminalIdRef.current) terminal.write(chunk.data);
    });
    void window.aiSsh.openTerminal(session.id).then(({ terminalId, replay }) => {
      if (disposed) {
        void window.aiSsh.closeTerminal(terminalId);
        return;
      }
      terminalIdRef.current = terminalId;
      if (replay) terminal.write(replay);
      const tracker = new TerminalCommandTracker();
      let inputQueue = Promise.resolve();
      terminal.onData((data) => {
        const actions = tracker.consume(data);
        inputQueue = inputQueue.then(async () => {
          for (const action of actions) {
            if (action.type === 'write') {
              await window.aiSsh.writeTerminal(session.id, terminalId, action.data);
            } else {
              const record = await window.aiSsh.submitTerminalCommand(session.id, terminalId, action.command);
              onCommandRecorded(record);
            }
          }
        }).catch(async (error: unknown) => {
          await window.aiSsh.writeTerminal(session.id, terminalId, '\x03').catch(() => undefined);
          terminal.writeln(`\r\n命令未执行：${error instanceof Error ? error.message : String(error)}`);
        });
      });
    }).catch((error: unknown) => {
      terminal.writeln(`\r\n终端打开失败：${error instanceof Error ? error.message : String(error)}`);
    });
    const resize = () => fitAddon.fit();
    window.addEventListener('resize', resize);
    return () => {
      disposed = true;
      window.removeEventListener('resize', resize);
      unsubscribe();
      if (terminalIdRef.current) void window.aiSsh.closeTerminal(terminalIdRef.current);
      terminal.dispose();
      terminalRef.current = undefined;
      fitAddonRef.current = undefined;
      terminalIdRef.current = undefined;
    };
  }, [session.id]);

  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      terminalRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (terminalRef.current) terminalRef.current.options.theme = terminalTheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return <div ref={containerRef} className={cn('terminal-canvas', !active && 'is-hidden')} />;
}

function EmptyTerminal(): JSX.Element {
  return (
    <div className="terminal-empty">
      <div className="terminal-empty-orb"><TerminalSquare /></div>
      <strong>终端正在等待连接</strong>
      <p>选择左侧服务器，确认授权等级后建立 SSH 会话。</p>
    </div>
  );
}

function WorkspaceTabs({ view, onChange }: { view: CenterView; onChange: (value: CenterView) => void }): JSX.Element {
  const tabs: Array<{ id: CenterView; label: string; icon: React.ReactNode }> = [
    { id: 'terminal', label: '主会话', icon: <TerminalSquare /> },
    { id: 'config', label: '服务器配置', icon: <Settings2 /> },
    { id: 'history', label: '执行记录', icon: <History /> }
  ];
  return (
    <div className="workspace-tabs">
      <div>{tabs.map((tab) => (
        <button type="button" key={tab.id} className={cn(view === tab.id && 'is-active')} onClick={() => onChange(tab.id)}>
          {tab.icon}{tab.label}
        </button>
      ))}</div>
      <span>会话工作台</span>
    </div>
  );
}

function ProfileEditor({
  form,
  busy,
  onChange,
  onSave
}: {
  form: ConnectionProfileInput;
  busy: boolean;
  onChange: (form: ConnectionProfileInput) => void;
  onSave: () => void;
}): JSX.Element {
  const [showPassword, setShowPassword] = useState(false);
  const [showPassphrase, setShowPassphrase] = useState(false);
  return (
    <div className="profile-editor">
      <div className="editor-heading"><div><strong>服务器配置</strong><span>凭据由系统安全存储，敏感字段不会回显。</span></div><Button onClick={onSave} disabled={busy}><Save />保存</Button></div>
      <div className="editor-grid">
        <Field label="配置名称"><Input value={form.name} onChange={(e) => onChange({ ...form, name: e.target.value })} /></Field>
        <Field label="用户名"><Input value={form.username} onChange={(e) => onChange({ ...form, username: e.target.value })} /></Field>
        <Field label="主机地址"><Input value={form.host} onChange={(e) => onChange({ ...form, host: e.target.value })} /></Field>
        <Field label="端口"><Input type="number" value={form.port} onChange={(e) => onChange({ ...form, port: Number(e.target.value) })} /></Field>
        <Field label="认证方式"><Select value={form.authMethod} onChange={(e) => onChange({ ...form, authMethod: e.target.value as AuthMethod })}>{ENABLED_AUTH_METHODS.map((method) => <option key={method} value={method}>{AUTH_LABELS[method]}</option>)}</Select></Field>
        <Field label="密码"><SecretInput shown={showPassword} placeholder="留空表示不修改" value={form.password ?? ''} onToggle={() => setShowPassword((value) => !value)} onChange={(value) => onChange({ ...form, password: value })} /></Field>
        <Field label="私钥路径"><Input disabled={form.authMethod !== 'private_key'} value={form.privateKeyPath ?? ''} onChange={(e) => onChange({ ...form, privateKeyPath: e.target.value })} /></Field>
        <Field label="私钥口令"><SecretInput shown={showPassphrase} disabled={form.authMethod !== 'private_key'} value={form.privateKeyPassphrase ?? ''} onToggle={() => setShowPassphrase((value) => !value)} onChange={(value) => onChange({ ...form, privateKeyPassphrase: value })} /></Field>
        <Field label="连接超时 MS"><Input type="number" value={form.connectTimeoutMs} onChange={(e) => onChange({ ...form, connectTimeoutMs: Number(e.target.value) })} /></Field>
        <Field label="KEEPALIVE MS"><Input type="number" value={form.keepaliveIntervalMs} onChange={(e) => onChange({ ...form, keepaliveIntervalMs: Number(e.target.value) })} /></Field>
        <Field label="本地文件允许目录"><Input placeholder="例如 C:\\Users\\你的用户名\\Downloads" value={form.localTransferRoot ?? ''} onChange={(e) => onChange({ ...form, localTransferRoot: e.target.value })} /></Field>
        <Field label="远程文件允许目录（每行一个）"><textarea placeholder={'例如\n/srv/app\n/var/log/app'} value={(form.remoteTransferRoots ?? []).join('\n')} onChange={(e) => onChange({ ...form, remoteTransferRoots: e.target.value.split(/\r?\n/).map((root) => root.trim()).filter(Boolean) })} /></Field>
      </div>
    </div>
  );
}

function SecretInput({ shown, disabled, value, placeholder, onToggle, onChange }: { shown: boolean; disabled?: boolean; value: string; placeholder?: string; onToggle: () => void; onChange: (value: string) => void }): JSX.Element {
  const Icon = shown ? EyeOff : Eye;
  return <div className="secret-input"><Input type={shown ? 'text' : 'password'} disabled={disabled} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /><button type="button" disabled={disabled} onClick={onToggle} aria-label={shown ? '隐藏密码' : '显示密码'}><Icon /></button></div>;
}

function HistoryView({ history }: { history: CommandRecord[] }): JSX.Element {
  return (
    <div className="history-view">
      <div className="editor-heading"><div><strong>执行记录</strong><span>记录当前 SSH 会话执行的命令；交互输出保留在主会话。</span></div><FileClock /></div>
      <div className="history-list">
        {history.length === 0 ? <div className="content-empty">当前会话还没有命令记录</div> : history.map((record) => (
          <article key={record.id}>
            <div><code>{record.command}</code><span className={cn(record.exitCode === 0 && 'is-success')}>{record.exitCode === undefined ? '交互终端' : `退出码 ${record.exitCode}`}</span></div>
            <p>{record.summary}</p><time>{formatTime(record.finishedAt ?? record.startedAt)}</time>
          </article>
        ))}
      </div>
    </div>
  );
}

export function CenterWorkbench({
  profile,
  session,
  sessions,
  form,
  authorizationLevel,
  codexPaused,
  history,
  view,
  busy,
  message,
  onViewChange,
  onFormChange,
  onAuthorizationLevelChange,
  onToggleCodexPause,
  onConnect,
  onDisconnect,
  onHealthCheck,
  onSave,
  onOpenTransfer,
  onCommandRecorded
}: {
  profile?: ConnectionProfile;
  session?: ConnectionSession;
  sessions: ConnectionSession[];
  form: ConnectionProfileInput;
  authorizationLevel: AuthorizationLevel;
  codexPaused: boolean;
  history: CommandRecord[];
  view: CenterView;
  busy: boolean;
  message?: string;
  onViewChange: (value: CenterView) => void;
  onFormChange: (form: ConnectionProfileInput) => void;
  onAuthorizationLevelChange: (value: AuthorizationLevel) => void;
  onToggleCodexPause: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onHealthCheck: () => void;
  onSave: () => void;
  onOpenTransfer: () => void;
  onCommandRecorded: (record: CommandRecord) => void;
}): JSX.Element {
  return (
    <main className="center-workbench">
      <SessionHeader profile={profile} session={session} authorizationLevel={authorizationLevel} codexPaused={codexPaused} busy={busy} onAuthorizationLevelChange={onAuthorizationLevelChange} onToggleCodexPause={onToggleCodexPause} onHealthCheck={onHealthCheck} onConnect={onConnect} onDisconnect={onDisconnect} onOpenTransfer={onOpenTransfer} />
      {message ? <div className="workbench-toast">{message}</div> : null}
      <section className="workspace-surface workbench-panel">
        <WorkspaceTabs view={view} onChange={onViewChange} />
        <div className={cn('terminal-workspace', view !== 'terminal' && 'is-hidden')}>
          {sessions.map((item) => (
            <TerminalPanel key={item.id} session={item} active={view === 'terminal' && session?.id === item.id} onCommandRecorded={onCommandRecorded} />
          ))}
          {!session ? <EmptyTerminal /> : null}
        </div>
        {view === 'config' ? <ProfileEditor form={form} busy={busy} onChange={onFormChange} onSave={onSave} /> : null}
        {view === 'history' ? <HistoryView history={history} /> : null}
      </section>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return <label className="form-field"><Label>{label}</Label>{children}</label>;
}

function ActivityTimeline({
  history,
  actions,
  session,
  busy,
  onApprove,
  onReject
}: {
  history: CommandRecord[];
  actions: CodrivingAction[];
  session?: ConnectionSession;
  busy: boolean;
  onApprove: (action: CodrivingAction) => void;
  onReject: (action: CodrivingAction) => void;
}): JSX.Element {
  const records = takeRecentChronological(history, 3);
  const recentActions = takeRecentChronological(actions, 6);
  return (
    <div className={cn('activity-timeline', (session || recentActions.some((action) => action.status === 'running' || action.status === 'pending_approval')) && 'has-live')}>
      {session ? (
        <div className="activity-event is-live is-normal">
          <i />
          <div className="activity-event-flags"><span className="activity-phase">进行中</span><time>{formatTime(session.openedAt)}</time></div>
          <strong>SSH 会话运行中</strong>
          <p>会话保持在线，可继续使用终端和文件舱。</p>
        </div>
      ) : null}
      {recentActions.map((action) => {
        const live = action.status === 'running' || action.status === 'pending_approval' || action.status === 'paused';
        const phase = action.status === 'pending_approval'
          ? '等待批准'
          : action.status === 'running'
            ? '进行中'
            : action.status === 'paused'
              ? '已暂停'
              : action.status === 'interrupted'
                ? '已中断'
                : '历史';
        return (
          <div className={cn('activity-event codriving-event', live ? 'is-live' : 'is-history', action.risk === 'high' ? 'is-high' : 'is-normal', action.status === 'pending_approval' && 'is-pending-approval')} key={action.id}>
            <i />
            <div className="activity-event-flags">
              <span className="activity-phase">{phase}</span>
              {action.risk === 'high' ? <span className="activity-risk">高危</span> : null}
              <time>{formatTime(action.updatedAt)}</time>
            </div>
            <strong>{action.actor === 'codex' ? 'Codex' : action.actor === 'user' ? '用户' : '系统'} · {action.kind === 'file_transfer' ? '文件操作' : action.kind === 'control' ? '共驾控制' : '执行命令'}</strong>
            <p>{action.reason}</p>
            <code>{action.summary}</code>
            {action.status === 'pending_approval' ? (
              <div className="codriving-approval-actions">
                <SecondaryButton disabled={busy} onClick={() => onReject(action)}>拒绝</SecondaryButton>
                <DangerButton disabled={busy} onClick={() => onApprove(action)}>批准执行</DangerButton>
              </div>
            ) : null}
          </div>
        );
      })}
      {records.map((record) => {
        const state = getCommandActivityState(record);
        return (
          <div className={cn('activity-event', state.phase === 'live' ? 'is-live' : 'is-history', state.risk === 'high' ? 'is-high' : 'is-normal')} key={record.id}>
            <i />
            <div className="activity-event-flags">
              <span className="activity-phase">{state.phase === 'live' ? '进行中' : '历史'}</span>
              {state.risk === 'high' ? <span className="activity-risk">高危</span> : null}
              <time>{formatTime(record.finishedAt ?? record.startedAt)}</time>
            </div>
            <strong>执行命令</strong>
            <p>{record.summary}</p>
            <code>{record.command}</code>
          </div>
        );
      })}
      {!session && records.length === 0 && recentActions.length === 0 ? (
        <div className="activity-event is-live is-normal">
          <i />
          <div className="activity-event-flags"><span className="activity-phase">等待中</span><time>现在</time></div>
          <strong>等待建立连接</strong>
          <p>选择服务器并连接后，这里会显示真实操作轨迹。</p>
        </div>
      ) : null}
    </div>
  );
}

function HostKeyApproval({ challenge, busy, onConfirm }: { challenge: HostKeyTrustChallenge; busy: boolean; onConfirm: () => void }): JSX.Element {
  return (
    <div className="host-key-approval">
      <div><strong>需要核对主机指纹</strong><span>{challenge.risk === 'changed' ? '高风险' : '首次连接'}</span></div>
      <p>{challenge.risk === 'changed' ? '服务器指纹发生变化，请通过可信渠道核对后再替换。' : '请通过可信渠道核对服务器提供的 SHA-256 指纹。'}</p>
      <code>{challenge.newFingerprint}</code>
      <DangerButton disabled={busy} onClick={onConfirm}>{challenge.risk === 'changed' ? '确认并替换指纹' : '信任此主机'}</DangerButton>
    </div>
  );
}

function TransferPanel({
  profile,
  session,
  busy,
  onUploadFiles,
  onDownloadFile
}: {
  profile?: ConnectionProfile;
  session?: ConnectionSession;
  busy: boolean;
  onUploadFiles: (files: LocalFileSelection[], remoteDirectory: string) => Promise<void>;
  onDownloadFile: (entry: RemoteFileEntry) => Promise<void>;
}): JSX.Element {
  const remoteRoots = useMemo(() => {
    const normalized = (profile?.remoteTransferRoots ?? []).flatMap((root) => {
      try {
        return [normalizeRemotePath(root)];
      } catch {
        return [];
      }
    });
    return [...new Set(normalized)];
  }, [profile?.remoteTransferRoots]);
  const [selectedRoot, setSelectedRoot] = useState('');
  const [directory, setDirectory] = useState('');
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [panelError, setPanelError] = useState<string>();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const savedLocationsRef = useRef(new Map<string, { root: string; directory: string }>());
  const selectedRootRef = useRef(selectedRoot);
  const directoryRef = useRef(directory);
  const rootsKey = remoteRoots.join('\u0000');
  const profileKey = profile?.id ?? '';
  const withinTransferBoundary = isRemotePathWithinRoots(directory, remoteRoots);
  const canTransfer = Boolean(
    session && profile?.localTransferRoot && directory && withinTransferBoundary && !busy
  );

  selectedRootRef.current = selectedRoot;
  directoryRef.current = directory;

  useEffect(() => {
    const saved = savedLocationsRef.current.get(profileKey);
    const root = saved && remoteRoots.includes(saved.root) ? saved.root : remoteRoots[0] ?? '';
    let nextDirectory = root || '/';
    if (saved) {
      try {
        nextDirectory = normalizeRemotePath(saved.directory);
      } catch {
        nextDirectory = root || '/';
      }
    }
    setSelectedRoot(root);
    setDirectory(nextDirectory);
    setEntries([]);
    setPanelError(undefined);
    return () => {
      if (profileKey) {
        savedLocationsRef.current.set(profileKey, {
          root: selectedRootRef.current,
          directory: directoryRef.current
        });
      }
    };
  }, [profileKey, rootsKey]);

  useEffect(() => {
    if (!session || !directory) {
      setEntries([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setPanelError(undefined);
    void window.aiSsh.listRemoteDirectory(session.id, directory).then((nextEntries) => {
      if (!cancelled) setEntries(nextEntries);
    }).catch((error: unknown) => {
      if (!cancelled) {
        setEntries([]);
        setPanelError(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [session?.id, directory, refreshVersion]);

  function changeRoot(root: string): void {
    setSelectedRoot(root);
    setDirectory(root);
  }

  async function upload(files: LocalFileSelection[]): Promise<void> {
    if (!canTransfer || files.length === 0) return;
    setPanelError(undefined);
    try {
      await onUploadFiles(files, directory);
      setRefreshVersion((value) => value + 1);
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error));
    }
  }

  async function chooseFiles(): Promise<void> {
    if (!canTransfer) return;
    try {
      const files = await window.aiSsh.pickLocalFiles(profile?.localTransferRoot);
      await upload(files);
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error));
    }
  }

  function containsFiles(event: React.DragEvent): boolean {
    return Array.from(event.dataTransfer.types).includes('Files');
  }

  function handleDragEnter(event: React.DragEvent<HTMLDivElement>): void {
    if (!canTransfer || !containsFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>): void {
    if (!canTransfer || !containsFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>): void {
    if (!containsFiles(event)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>): void {
    if (!canTransfer || !containsFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    const files = Array.from(event.dataTransfer.files).flatMap<LocalFileSelection>((file) => {
      try {
        const filePath = window.aiSsh.getPathForDroppedFile(file);
        return filePath ? [{ name: file.name, path: filePath }] : [];
      } catch {
        return [];
      }
    });
    if (files.length === 0) {
      setPanelError('没有读取到可上传的本地文件');
      return;
    }
    void upload(files);
  }

  async function download(entry: RemoteFileEntry): Promise<void> {
    setPanelError(undefined);
    try {
      await onDownloadFile(entry);
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div
      className={cn('transfer-panel', dragging && 'is-dragging')}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="file-browser-actions">
        <Select
          aria-label="远程允许目录"
          disabled={!session || remoteRoots.length === 0 || busy}
          value={selectedRoot}
          onChange={(event) => changeRoot(event.target.value)}
        >
          {remoteRoots.length === 0 ? <option value="">未配置传输目录（仅浏览）</option> : null}
          {remoteRoots.map((root) => <option key={root} value={root}>{root}</option>)}
        </Select>
        <button
          type="button"
          disabled={!directory || directory === '/' || loading || busy}
          title={directory === '/' ? '已到服务器根目录' : '返回上级目录'}
          aria-label={directory === '/' ? '已到服务器根目录' : '返回上级目录'}
          onClick={() => setDirectory(getRemoteParent(directory, '/'))}
        ><FolderUp /></button>
        <button
          type="button"
          disabled={!session || !directory || loading || busy}
          title="刷新目录"
          aria-label="刷新目录"
          onClick={() => setRefreshVersion((value) => value + 1)}
        ><RefreshCw /></button>
        <button
          type="button"
          className="file-upload-action"
          disabled={!canTransfer}
          title="选择本地文件上传"
          onClick={() => void chooseFiles()}
        ><Upload /><span>上传</span></button>
      </div>

      <div className="remote-path-bar" title={directory || '尚未选择远程目录'}>
        <Server /><code>{directory || '尚未选择远程目录'}</code>
      </div>

      <div className="remote-file-list" role="table" aria-label="远程服务器文件">
        <div className="remote-file-head" role="row">
          <span role="columnheader">名称</span><span role="columnheader">大小 / 修改时间</span>
        </div>
        {!session ? <div className="file-browser-empty">连接服务器后可浏览远程文件</div> : null}
        {session && loading ? <div className="file-browser-empty"><RefreshCw className="is-spinning" />正在读取目录…</div> : null}
        {session && !loading && panelError ? (
          <div className="file-browser-error"><span>{panelError}</span><button type="button" onClick={() => setRefreshVersion((value) => value + 1)}>重试</button></div>
        ) : null}
        {session && !loading && !panelError && entries.length === 0 ? <div className="file-browser-empty">当前目录为空</div> : null}
        {!loading && !panelError ? entries.map((entry) => {
          const EntryIcon = entry.type === 'directory' ? Folder : entry.type === 'symlink' ? Link2 : FileText;
          return (
            <div className={cn('remote-file-row', entry.type === 'directory' && 'is-directory')} role="row" key={entry.path}>
              <button
                type="button"
                className="remote-entry-main"
                disabled={entry.type !== 'directory'}
                title={entry.type === 'directory' ? '双击进入目录' : entry.path}
                onDoubleClick={() => entry.type === 'directory' && setDirectory(entry.path)}
                onKeyDown={(event) => {
                  if (entry.type === 'directory' && event.key === 'Enter') setDirectory(entry.path);
                }}
              >
                <EntryIcon />
                <span><b>{entry.name}</b><small>{entry.type === 'directory' ? '文件夹' : entry.type === 'symlink' ? '符号链接（不可进入）' : '文件'}</small></span>
              </button>
              <div className="remote-entry-meta">
                <span>{entry.type === 'file' ? formatFileSize(entry.size) : '—'}</span>
                <time>{formatFileTime(entry.modifiedAt)}</time>
              </div>
              {entry.type === 'file' ? (
                <button
                  type="button"
                  className="remote-download-action"
                  disabled={!canTransfer}
                  title="下载到本地"
                  aria-label={`下载 ${entry.name}`}
                  onClick={() => void download(entry)}
                ><Download /></button>
              ) : null}
            </div>
          );
        }) : null}
      </div>

      {!profile?.localTransferRoot ? (
        <p className="transfer-hint">配置本地文件允许目录后，才能上传或下载。</p>
      ) : !withinTransferBoundary ? (
        <p className="transfer-hint">当前目录仅供浏览；进入配置的远程允许目录后可传输文件。</p>
      ) : (
        <p className="transfer-hint">可点击上传，或把本地文件拖到文件列表中。</p>
      )}
      {dragging ? <div className="file-drop-overlay"><Upload /><strong>释放以上传到当前目录</strong></div> : null}
    </div>
  );
}

export function ActivityRail({
  profile,
  session,
  history,
  actions,
  challenge,
  view,
  busy,
  onViewChange,
  onUploadFiles,
  onDownloadFile,
  onConfirmHostKey,
  onApproveAction,
  onRejectAction
}: {
  profile?: ConnectionProfile;
  session?: ConnectionSession;
  history: CommandRecord[];
  actions: CodrivingAction[];
  challenge?: HostKeyTrustChallenge;
  view: InspectorView;
  busy: boolean;
  onViewChange: (value: InspectorView) => void;
  onUploadFiles: (files: LocalFileSelection[], remoteDirectory: string) => Promise<void>;
  onDownloadFile: (entry: RemoteFileEntry) => Promise<void>;
  onConfirmHostKey: (challenge: HostKeyTrustChallenge) => void;
  onApproveAction: (action: CodrivingAction) => void;
  onRejectAction: (action: CodrivingAction) => void;
}): JSX.Element {
  return (
    <aside className="activity-rail workbench-panel">
      <div className="activity-rail-head">
        <div className="ai-core"><i /></div>
        <div><strong>{view === 'activity' ? '协作轨迹' : '文件舱'}</strong><span>{session ? `${profile?.name} · 会话运行中` : '等待你的下一步操作'}</span></div>
        <div className="rail-tabs"><button type="button" className={cn(view === 'activity' && 'is-active')} onClick={() => onViewChange('activity')} title="协作轨迹"><Activity /></button><button type="button" className={cn(view === 'transfer' && 'is-active')} onClick={() => onViewChange('transfer')} title="文件传输"><Upload /></button></div>
      </div>
      <div className="activity-rail-body">
        <div className={cn('rail-view', view !== 'activity' && 'is-hidden')}>
          <ActivityTimeline history={history} actions={actions} session={session} busy={busy} onApprove={onApproveAction} onReject={onRejectAction} />
          {challenge ? <HostKeyApproval challenge={challenge} busy={busy} onConfirm={() => onConfirmHostKey(challenge)} /> : null}
        </div>
        <div className={cn('rail-view rail-transfer-view', view !== 'transfer' && 'is-hidden')}>
          <TransferPanel profile={profile} session={session} busy={busy} onUploadFiles={onUploadFiles} onDownloadFile={onDownloadFile} />
        </div>
      </div>
    </aside>
  );
}
