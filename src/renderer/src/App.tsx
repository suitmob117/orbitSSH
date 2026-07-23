import { useEffect, useMemo, useState } from 'react';
import type {
  AuthorizationLevel,
  CommandRecord,
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectionSession,
  FileTransferRequest,
  HostKeyTrustChallenge
} from '@shared/types';
import {
  ActivityRail,
  AppTopbar,
  CenterWorkbench,
  ServerSidebar,
  type CenterView,
  type InspectorView
} from './components/workbench';

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

type ThemePreference = 'system' | 'light' | 'dark';

const THEME_STORAGE_KEY = 'ai-ssh:theme-preference';

function getInitialThemePreference(): ThemePreference {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'system' || stored === 'light' || stored === 'dark' ? stored : 'system';
}

function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
  if (preference !== 'system') return preference;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
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

export function App(): JSX.Element {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [sessions, setSessions] = useState<ConnectionSession[]>([]);
  const [history, setHistory] = useState<CommandRecord[]>([]);
  const [hostKeyChallenges, setHostKeyChallenges] = useState<HostKeyTrustChallenge[]>([]);
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
  const [centerView, setCenterView] = useState<CenterView>('terminal');
  const [inspectorView, setInspectorView] = useState<InspectorView>('activity');
  const [themePreference, setThemePreference] = useState<ThemePreference>(getInitialThemePreference);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId);
  const activeSession = useMemo(() => {
    if (!selectedProfileId) return undefined;
    return sessions.find(
      (session) => session.profileId === selectedProfileId && session.health !== 'disconnected'
    );
  }, [selectedProfileId, sessions]);
  const visibleHistory = activeSession
    ? history.filter((record) => record.sessionId === activeSession.id)
    : [];
  const hostKeyChallenge = hostKeyChallenges.find(
    (challenge) => challenge.profileId === selectedProfileId
  );

  async function refresh(): Promise<void> {
    const [nextProfiles, nextSessions, nextHistory, nextChallenges] = await Promise.all([
      window.aiSsh.listProfiles(),
      window.aiSsh.listSessions(),
      window.aiSsh.listHistory(),
      window.aiSsh.listHostKeyTrustChallenges()
    ]);
    setProfiles(nextProfiles);
    setSessions(nextSessions);
    setHistory(nextHistory);
    setHostKeyChallenges(nextChallenges);
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
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const theme = resolveTheme(themePreference);
      document.documentElement.classList.toggle('dark', theme === 'dark');
      document.documentElement.style.colorScheme = theme;
    };
    applyTheme();
    window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    if (themePreference === 'system') {
      media.addEventListener('change', applyTheme);
      return () => media.removeEventListener('change', applyTheme);
    }
    return undefined;
  }, [themePreference]);

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
    setCenterView('terminal');
  }

  function createProfile(): void {
    setEditingId(undefined);
    setSelectedProfileId(undefined);
    setForm(DEFAULT_FORM);
    setCommandOutput('');
    setCenterView('config');
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
    } finally {
      setBusy(false);
    }
  }

  async function confirmHostKeyTrust(challenge: HostKeyTrustChallenge): Promise<void> {
    setBusy(true);
    try {
      await window.aiSsh.confirmHostKeyTrust({
        profileId: challenge.profileId,
        challengeId: challenge.challengeId
      });
      await refresh();
      setMessage('主机指纹已确认，请再次连接以建立会话');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function openSession(): Promise<void> {
    if (!selectedProfileId) return;
    setBusy(true);
    setMessage('正在连接服务器…');
    try {
      const session = await window.aiSsh.openSession(selectedProfileId, authorizationLevel);
      await refresh();
      setTransfer((current) => ({ ...current, sessionId: session.id }));
      setCenterView('terminal');
      setMessage('连接已建立，终端会复用当前会话');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setHostKeyChallenges(await window.aiSsh.listHostKeyTrustChallenges());
    } finally {
      setBusy(false);
    }
  }

  async function closeSession(): Promise<void> {
    if (!activeSession) return;
    await window.aiSsh.closeSession(activeSession.id);
    await refresh();
    setMessage('会话已安全关闭');
  }

  async function checkHealth(): Promise<void> {
    if (!activeSession) return;
    setBusy(true);
    try {
      const session = await window.aiSsh.getSessionHealth(activeSession.id);
      setSessions((items) => items.map((item) => (item.id === session.id ? session : item)));
      setMessage(`健康检查完成：${session.health === 'connected' ? '连接正常' : '连接异常'}`);
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
      setMessage(`命令完成，退出码 ${result.record.exitCode ?? '未知'}`);
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
      setMessage(transfer.direction === 'upload' ? '文件上传完成' : '文件下载完成');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ai-ssh-workbench">
      <AppTopbar
        profileName={selectedProfile?.name}
        themePreference={themePreference}
        onThemeChange={setThemePreference}
      />
      <div className="workbench-grid">
        <ServerSidebar
          profiles={profiles}
          sessions={sessions}
          selectedProfileId={selectedProfileId}
          onCreate={createProfile}
          onSelect={selectProfile}
        />
        <CenterWorkbench
          profile={selectedProfile}
          session={activeSession}
          form={form}
          authorizationLevel={authorizationLevel}
          history={visibleHistory}
          view={centerView}
          command={command}
          commandOutput={commandOutput}
          busy={busy}
          message={message}
          onViewChange={setCenterView}
          onFormChange={setForm}
          onAuthorizationLevelChange={setAuthorizationLevel}
          onCommandChange={setCommand}
          onConnect={() => void openSession()}
          onDisconnect={() => void closeSession()}
          onHealthCheck={() => void checkHealth()}
          onRunCommand={() => void runCommand()}
          onSave={() => void saveProfile()}
          onOpenTransfer={() => setInspectorView('transfer')}
        />
        <ActivityRail
          profile={selectedProfile}
          session={activeSession}
          history={visibleHistory}
          challenge={hostKeyChallenge}
          authorizationLevel={authorizationLevel}
          transfer={transfer}
          view={inspectorView}
          busy={busy}
          onViewChange={setInspectorView}
          onTransferChange={setTransfer}
          onTransfer={() => void transferFile()}
          onConfirmHostKey={(challenge) => void confirmHostKeyTrust(challenge)}
        />
      </div>
    </div>
  );
}
