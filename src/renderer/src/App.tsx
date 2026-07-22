import { useEffect, useMemo, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import {
  Activity,
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  FolderInput,
  Play,
  PlugZap,
  Power,
  RefreshCw,
  Moon,
  Save,
  Sun,
  TerminalSquare,
  Upload
} from 'lucide-react';
import type {
  AuthMethod,
  AuthorizationLevel,
  CommandRecord,
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectionSession,
  FileTransferRequest,
  HostKeyTrustChallenge
} from '@shared/types';
import { Badge, Button, DangerButton, Input, Label, SecondaryButton, Select } from './components/ui';
import { cn } from './lib/utils';

const AUTH_LABELS: Record<AuthMethod, string> = {
  saved_password: '保存密码',
  password_prompt: '每次输入密码',
  ssh_agent: 'SSH Agent',
  private_key: '私钥'
};

const ENABLED_AUTH_METHODS: AuthMethod[] = ['saved_password', 'ssh_agent', 'private_key'];

const AUTH_LEVEL_LABELS: Record<AuthorizationLevel, string> = {
  ask_every_time: '每次询问',
  auto_readonly: '自动只读',
  trusted_session: '信任会话'
};

const DEFAULT_FORM: ConnectionProfileInput = {
  name: '',
  host: '',
  port: 22,
  username: 'root',
  authMethod: 'saved_password',
  password: '',
  privateKeyPath: '',
  privateKeyPassphrase: '',
  rememberPrivateKeyPassphrase: false,
  connectTimeoutMs: 15000,
  keepaliveIntervalMs: 15000,
  jumpHost: '',
  localTransferRoot: '',
  remoteTransferRoots: []
};

function healthTone(health?: string): 'green' | 'amber' | 'red' | 'neutral' {
  if (health === 'connected') return 'green';
  if (health === 'degraded') return 'amber';
  if (health === 'disconnected') return 'red';
  return 'neutral';
}

function healthLabel(health?: string): string {
  if (health === 'connected') return '已连接';
  if (health === 'degraded') return '异常';
  if (health === 'disconnected') return '已断开';
  return '未连接';
}

function toProfileForm(profile: ConnectionProfile): ConnectionProfileInput {
  return {
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authMethod: profile.authMethod,
    password: '',
    privateKeyPath: profile.privateKeyPath ?? '',
    privateKeyPassphrase: '',
    rememberPrivateKeyPassphrase: Boolean(profile.privateKeyPassphraseCredentialId),
    connectTimeoutMs: profile.connectTimeoutMs,
    keepaliveIntervalMs: profile.keepaliveIntervalMs,
    jumpHost: profile.jumpHost ?? '',
    localTransferRoot: profile.localTransferRoot ?? '',
    remoteTransferRoots: profile.remoteTransferRoots ?? []
  };
}

function TerminalPanel({ session }: { session?: ConnectionSession }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal>();
  const terminalIdRef = useRef<string>();

  useEffect(() => {
    if (!session || !containerRef.current) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: '#0a0e17',
        foreground: '#d7e3f4',
        cursor: '#22d3ee',
        cursorAccent: '#0a0e17',
        selectionBackground: 'rgba(34,211,238,0.25)'
      }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();
    terminal.writeln('正在打开会话终端...');
    terminalRef.current = terminal;

    let disposed = false;
    const unsubscribe = window.aiSsh.onTerminalData((chunk) => {
      if (chunk.terminalId === terminalIdRef.current) {
        terminal.write(chunk.data);
      }
    });

    void window.aiSsh
      .openTerminal(session.id)
      .then((terminalId) => {
        if (disposed) {
          void window.aiSsh.closeTerminal(terminalId);
          return;
        }
        terminalIdRef.current = terminalId;
        terminal.onData((data) => {
          void window.aiSsh.writeTerminal(terminalId, data);
        });
      })
      .catch((error: unknown) => {
        terminal.writeln(`\r\n终端打开失败：${error instanceof Error ? error.message : String(error)}`);
      });

    const onResize = () => fitAddon.fit();
    window.addEventListener('resize', onResize);

    return () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      unsubscribe();
      if (terminalIdRef.current) {
        void window.aiSsh.closeTerminal(terminalIdRef.current);
      }
      terminal.dispose();
      terminalRef.current = undefined;
      terminalIdRef.current = undefined;
    };
  }, [session?.id]);

  return (
    <div
      ref={containerRef}
      className="h-full min-h-[220px] overflow-hidden rounded-lg bg-[#0a0e17] ring-1 ring-border/60"
    />
  );
}

export function App(): JSX.Element {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [sessions, setSessions] = useState<ConnectionSession[]>([]);
  const [history, setHistory] = useState<CommandRecord[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  const [editingId, setEditingId] = useState<string>();
  const [form, setForm] = useState<ConnectionProfileInput>(DEFAULT_FORM);
  const [authorizationLevel, setAuthorizationLevel] = useState<AuthorizationLevel>('ask_every_time');
  const [command, setCommand] = useState('pwd && uptime');
  const [commandOutput, setCommandOutput] = useState('');
  const [transfer, setTransfer] = useState<FileTransferRequest>({
    sessionId: '',
    localPath: '',
    remotePath: '',
    direction: 'upload'
  });
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showPrivateKeyPassphrase, setShowPrivateKeyPassphrase] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [hostKeyChallenges, setHostKeyChallenges] = useState<HostKeyTrustChallenge[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId);
  const activeSession = useMemo(() => {
    if (!selectedProfileId) {
      return undefined;
    }
    return sessions.find((session) => session.profileId === selectedProfileId && session.health !== 'disconnected');
  }, [selectedProfileId, sessions]);

  async function refresh(): Promise<void> {
    const [nextProfiles, nextSessions, nextHistory, nextHostKeyChallenges] = await Promise.all([
      window.aiSsh.listProfiles(),
      window.aiSsh.listSessions(),
      window.aiSsh.listHistory(),
      window.aiSsh.listHostKeyTrustChallenges()
    ]);
    setProfiles(nextProfiles);
    setSessions(nextSessions);
    setHistory(nextHistory);
    setHostKeyChallenges(nextHostKeyChallenges);
    if (!selectedProfileId && nextProfiles[0]) {
      setSelectedProfileId(nextProfiles[0].id);
      setEditingId(nextProfiles[0].id);
      setForm(toProfileForm(nextProfiles[0]));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    if (activeSession) {
      setTransfer((current) => ({ ...current, sessionId: activeSession.id }));
    }
  }, [activeSession?.id]);

  function selectProfile(profile: ConnectionProfile): void {
    setSelectedProfileId(profile.id);
    setEditingId(profile.id);
    setForm(toProfileForm(profile));
    setCommandOutput('');
    setTerminalOpen(false);
  }

  async function saveProfile(): Promise<void> {
    setBusy(true);
    setMessage(undefined);
    try {
      const saved = await window.aiSsh.saveProfile(form, editingId);
      await refresh();
      setSelectedProfileId(saved.id);
      setEditingId(saved.id);
      setForm(toProfileForm(saved));
      setMessage('连接配置已保存');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setHostKeyChallenges(await window.aiSsh.listHostKeyTrustChallenges());
    } finally {
      setBusy(false);
    }
  }

  async function confirmHostKeyTrust(challenge: HostKeyTrustChallenge): Promise<void> {
    setBusy(true);
    try {
      await window.aiSsh.confirmHostKeyTrust({ profileId: challenge.profileId, challengeId: challenge.challengeId });
      await refresh();
      setMessage('主机指纹已确认。请再次点击“连接”以建立会话。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function openSession(): Promise<void> {
    if (!selectedProfileId) return;
    setBusy(true);
    setMessage('正在连接...');
    try {
      const session = await window.aiSsh.openSession(selectedProfileId, authorizationLevel);
      await refresh();
      setTransfer((current) => ({ ...current, sessionId: session.id }));
      setMessage('连接已建立，后续操作会复用此会话');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function closeSession(): Promise<void> {
    if (!activeSession) return;
    await window.aiSsh.closeSession(activeSession.id);
    setTerminalOpen(false);
    await refresh();
  }

  async function checkHealth(): Promise<void> {
    if (!activeSession) return;
    setBusy(true);
    try {
      const session = await window.aiSsh.getSessionHealth(activeSession.id);
      setSessions((items) => items.map((item) => (item.id === session.id ? session : item)));
      setMessage(`健康检查：${healthLabel(session.health)}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function runCommand(): Promise<void> {
    if (!activeSession || !command.trim()) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await window.aiSsh.runCommand(activeSession.id, command);
      setCommandOutput([result.stdout, result.stderr].filter(Boolean).join('\n'));
      setHistory((items) => [...items, result.record]);
      setMessage(`命令完成：退出码 ${result.record.exitCode ?? '未知'}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function transferFile(): Promise<void> {
    if (!activeSession) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await window.aiSsh.transferFile({ ...transfer, sessionId: activeSession.id });
      setMessage(transfer.direction === 'upload' ? '上传完成' : '下载完成');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const visibleHistory = activeSession ? history.filter((record) => record.sessionId === activeSession.id) : [];
  const hostKeyChallenge = hostKeyChallenges.find((challenge) => challenge.profileId === selectedProfileId);

  return (
    <div className="grid h-full grid-cols-[280px_1fr_340px] grid-rows-[1fr_auto] overflow-hidden">
      <aside className="glass border-r border-border/60">
        <div className="flex h-16 items-center gap-3 border-b border-border/60 px-4">
          <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg shadow-glow-sm ring-1 ring-border">
            <img src="/icon.png" alt="AI SSH" className="h-full w-full object-cover" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-wide text-gradient">AI SSH</div>
            <div className="truncate text-xs text-muted-foreground">本地持久连接工作台</div>
          </div>
          <button
            type="button"
            onClick={() => setTheme((value) => (value === 'dark' ? 'light' : 'dark'))}
            className="ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-all duration-200 hover:border-primary/40 hover:text-foreground"
            title="切换深色 / 浅色主题"
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
        <div className="space-y-2 p-3">
          <SecondaryButton
            className="w-full justify-start"
            onClick={() => {
              setEditingId(undefined);
              setSelectedProfileId(undefined);
              setForm(DEFAULT_FORM);
            }}
          >
            <FolderInput className="h-4 w-4" />
            新建连接
          </SecondaryButton>
          <div className="space-y-2">
            {profiles.map((profile) => {
              const session = sessions.find((item) => item.profileId === profile.id && item.health !== 'disconnected');
              return (
                <button
                  key={profile.id}
                  className={cn(
                    'w-full rounded-lg border p-3 text-left transition-all duration-200',
                    selectedProfileId === profile.id
                      ? 'border-primary/60 bg-primary/10 shadow-glow-sm'
                      : 'border-border/60 bg-transparent hover:border-border hover:bg-muted'
                  )}
                  onClick={() => selectProfile(profile)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{profile.name}</span>
                    <Badge tone={healthTone(session?.health)}>{healthLabel(session?.health)}</Badge>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {profile.username}@{profile.host}:{profile.port}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      <main className="min-w-0 overflow-auto p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-[220px] flex-1">
            <h1 className="text-2xl font-bold tracking-tight text-gradient">{selectedProfile?.name ?? '连接配置'}</h1>
            <p className="text-sm text-muted-foreground">配置服务器，建立一次连接，然后复用同一个会话执行操作。</p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">
            <Badge tone={healthTone(activeSession?.health)}>{healthLabel(activeSession?.health)}</Badge>
            <Select
              className="w-32 shrink-0"
              value={authorizationLevel}
              onChange={(event) => setAuthorizationLevel(event.target.value as AuthorizationLevel)}
            >
              {Object.entries(AUTH_LEVEL_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
            <Button onClick={openSession} disabled={!selectedProfileId || busy}>
              <PlugZap className="h-4 w-4" />
              连接
            </Button>
            <DangerButton onClick={closeSession} disabled={!activeSession}>
              <Power className="h-4 w-4" />
              关闭
            </DangerButton>
          </div>
        </div>

        {message ? (
          <div className="mb-4 animate-fade-in-up rounded-lg border border-primary/30 bg-primary/[0.07] px-4 py-2.5 text-sm text-foreground/90 shadow-glow-sm">{message}</div>
        ) : null}
        {hostKeyChallenge ? (
          <div className="mb-4 rounded-xl border border-amber-500/50 bg-amber-500/10 p-4 text-sm shadow-glow-sm">
            <div className="font-semibold text-amber-700 dark:text-amber-300">
              {hostKeyChallenge.risk === 'changed' ? '检测到服务器主机指纹变化' : '首次连接，需确认服务器身份'}
            </div>
            <p className="mt-1 text-muted-foreground">
              {hostKeyChallenge.risk === 'changed'
                ? '这可能意味着服务器重装，也可能存在中间人攻击。确认前请通过可信渠道核对。'
                : '请通过可信渠道核对服务器提供的 SHA-256 指纹后再确认。'}
            </p>
            <div className="mt-3 grid gap-2 font-mono text-xs">
              <div><span className="font-sans text-muted-foreground">旧指纹：</span>{hostKeyChallenge.oldFingerprint ?? '（首次信任，无旧指纹）'}</div>
              <div><span className="font-sans text-muted-foreground">新指纹：</span>{hostKeyChallenge.newFingerprint}</div>
            </div>
            <DangerButton className="mt-3" disabled={busy} onClick={() => void confirmHostKeyTrust(hostKeyChallenge)}>
              {hostKeyChallenge.risk === 'changed' ? '已核对，替换信任指纹' : '已核对，信任此主机'}
            </DangerButton>
          </div>
        ) : null}

        <section className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
          <div className="rounded-xl glass p-5 shadow-card">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-wide text-foreground/90">服务器配置</h2>
              <Button onClick={saveProfile} disabled={busy}>
                <Save className="h-4 w-4" />
                保存
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              <Field label="配置名称">
                <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
              </Field>
              <Field label="用户名">
                <Input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
              </Field>
              <Field label="主机地址">
                <Input value={form.host} onChange={(event) => setForm({ ...form, host: event.target.value })} />
              </Field>
              <Field label="端口">
                <Input
                  type="number"
                  value={form.port}
                  onChange={(event) => setForm({ ...form, port: Number(event.target.value) })}
                />
              </Field>
              <Field label="认证方式">
                <Select
                  value={form.authMethod}
                  onChange={(event) => setForm({ ...form, authMethod: event.target.value as AuthMethod })}
                >
                  {ENABLED_AUTH_METHODS.map((value) => (
                    <option key={value} value={value}>
                      {AUTH_LABELS[value]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="密码">
                <div className="relative">
                  <Input
                    className="pr-10"
                    type={showPassword ? 'text' : 'password'}
                    placeholder={editingId ? '留空表示不修改' : ''}
                    disabled={form.authMethod !== 'saved_password'}
                    value={form.password}
                    onChange={(event) => setForm({ ...form, password: event.target.value })}
                  />
                  <PasswordToggle
                    pressed={showPassword}
                    disabled={form.authMethod !== 'saved_password'}
                    onClick={() => setShowPassword((value) => !value)}
                  />
                </div>
              </Field>
              <Field label="私钥路径">
                <Input
                  disabled={form.authMethod !== 'private_key'}
                  value={form.privateKeyPath}
                  onChange={(event) => setForm({ ...form, privateKeyPath: event.target.value })}
                />
              </Field>
              <Field label="私钥口令">
                <div className="relative">
                  <Input
                    className="pr-10"
                    type={showPrivateKeyPassphrase ? 'text' : 'password'}
                    disabled={form.authMethod !== 'private_key'}
                    value={form.privateKeyPassphrase}
                    onChange={(event) => setForm({ ...form, privateKeyPassphrase: event.target.value })}
                  />
                  <PasswordToggle
                    pressed={showPrivateKeyPassphrase}
                    disabled={form.authMethod !== 'private_key'}
                    onClick={() => setShowPrivateKeyPassphrase((value) => !value)}
                  />
                </div>
              </Field>
              <Field label="连接超时 ms">
                <Input
                  type="number"
                  value={form.connectTimeoutMs}
                  onChange={(event) => setForm({ ...form, connectTimeoutMs: Number(event.target.value) })}
                />
              </Field>
              <Field label="Keepalive ms">
                <Input
                  type="number"
                  value={form.keepaliveIntervalMs}
                  onChange={(event) => setForm({ ...form, keepaliveIntervalMs: Number(event.target.value) })}
                />
              </Field>
              <Field label="本地文件允许目录">
                <Input
                  placeholder="例如 C:\\Users\\你的用户名\\Downloads"
                  value={form.localTransferRoot ?? ''}
                  onChange={(event) => setForm({ ...form, localTransferRoot: event.target.value })}
                />
              </Field>
              <Field label="远程文件允许目录（每行一个）">
                <textarea
                  className="h-20 w-full resize-none rounded-lg border border-input bg-background p-2 font-mono text-xs text-foreground outline-none transition-all placeholder:text-muted-foreground/60 hover:border-primary/40 focus:border-primary focus:ring-2 focus:ring-primary/20"
                  placeholder={'例如\n/srv/app\n/var/log/app'}
                  value={(form.remoteTransferRoots ?? []).join('\n')}
                  onChange={(event) => setForm({
                    ...form,
                    remoteTransferRoots: event.target.value.split(/\r?\n/).map((root) => root.trim()).filter(Boolean)
                  })}
                />
              </Field>
            </div>
          </div>

          <div className="rounded-xl glass p-5 shadow-card">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-wide text-foreground/90">命令执行</h2>
              <SecondaryButton onClick={checkHealth} disabled={!activeSession || busy}>
                <RefreshCw className="h-4 w-4" />
                健康检查
              </SecondaryButton>
            </div>
            <textarea
              className="h-28 w-full resize-none rounded-lg border border-input bg-background p-3 font-mono text-sm text-foreground outline-none transition-all placeholder:text-muted-foreground/60 hover:border-primary/40 focus:border-primary focus:ring-2 focus:ring-primary/20"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
            />
            <div className="mt-3 flex justify-end">
              <Button onClick={runCommand} disabled={!activeSession || busy}>
                <Play className="h-4 w-4" />
                执行命令
              </Button>
            </div>
            <pre className="mt-3 h-48 overflow-auto rounded-lg bg-[#0a0e17] p-3 font-mono text-xs text-slate-100 ring-1 ring-border/60">
              {commandOutput || '命令输出会显示在这里。'}
            </pre>
          </div>
        </section>

        <section className="mt-4 rounded-xl glass p-5 shadow-card">
          <div className="mb-3 flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold tracking-wide text-foreground/90">执行记录</h2>
          </div>
          <div className="max-h-56 space-y-2 overflow-auto">
            {visibleHistory.length === 0 ? (
              <div className="text-sm text-muted-foreground">暂无记录。</div>
            ) : (
              visibleHistory
                .slice()
                .reverse()
                .map((record) => (
                  <div key={record.id} className="rounded-lg border border-border/60 bg-muted/40 p-3 transition hover:border-border">
                    <div className="flex items-center justify-between gap-3">
                      <code className="truncate text-sm">{record.command}</code>
                      <Badge tone={record.exitCode === 0 ? 'green' : 'amber'}>退出码 {record.exitCode ?? '未知'}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">{record.summary}</div>
                  </div>
                ))
            )}
          </div>
        </section>
      </main>

      <aside className="glass border-l border-border/60 p-4">
        <div className="mb-4">
          <h2 className="text-sm font-semibold tracking-wide text-foreground/90">会话状态</h2>
          <div className="mt-3 space-y-2 text-sm">
            <InfoRow label="当前服务器" value={selectedProfile?.name ?? '未选择'} />
            <InfoRow label="连接状态" value={healthLabel(activeSession?.health)} />
            <InfoRow label="授权等级" value={AUTH_LEVEL_LABELS[authorizationLevel]} />
          </div>
        </div>

        <div className="border-t border-border/60 pt-4">
          <h2 className="mb-3 text-sm font-semibold tracking-wide text-foreground/90">文件传输</h2>
          <div className="space-y-3">
            <Field label="方向">
              <Select
                value={transfer.direction}
                onChange={(event) =>
                  setTransfer({ ...transfer, direction: event.target.value as FileTransferRequest['direction'] })
                }
              >
                <option value="upload">上传到服务器</option>
                <option value="download">下载到本地</option>
              </Select>
            </Field>
            <Field label="本地路径">
              <Input
                value={transfer.localPath}
                onChange={(event) => setTransfer({ ...transfer, localPath: event.target.value })}
              />
            </Field>
            <Field label="远程路径">
              <Input
                value={transfer.remotePath}
                onChange={(event) => setTransfer({ ...transfer, remotePath: event.target.value })}
              />
            </Field>
            <Button className="w-full" disabled={!activeSession || busy} onClick={transferFile}>
              {transfer.direction === 'upload' ? <Upload className="h-4 w-4" /> : <Download className="h-4 w-4" />}
              开始传输
            </Button>
          </div>
        </div>

        <div className="mt-4 border-t border-border/60 pt-4">
          <SecondaryButton className="w-full" disabled={!activeSession} onClick={() => setTerminalOpen((value) => !value)}>
            <TerminalSquare className="h-4 w-4" />
            {terminalOpen ? '隐藏终端' : '打开终端'}
          </SecondaryButton>
        </div>
      </aside>

      <div className={cn('col-span-3 glass border-t border-border/60 p-3', terminalOpen ? 'block' : 'hidden')}>
        <div className="mb-2 flex items-center gap-2 text-sm font-medium">
          <CheckCircle2 className="h-4 w-4 text-emerald-500 dark:text-emerald-400" />
          会话终端
        </div>
        <div className="h-[260px]">{terminalOpen ? <TerminalPanel session={activeSession} /> : null}</div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/40 px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-medium">{value}</span>
    </div>
  );
}

function PasswordToggle({
  pressed,
  disabled,
  onClick
}: {
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
}): JSX.Element {
  const Icon = pressed ? EyeOff : Eye;
  return (
    <button
      aria-label={pressed ? '隐藏密码' : '显示密码'}
      className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      disabled={disabled}
      type="button"
      onClick={onClick}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
