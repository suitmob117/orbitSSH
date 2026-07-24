import { useEffect, useMemo, useState } from 'react';
import type {
  AuthorizationLevel,
  CommandRecord,
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectionSession,
  HostKeyTrustChallenge,
  LocalFileSelection,
  RemoteFileEntry
} from '@shared/types';
import {
  ActivityRail,
  AppTopbar,
  CenterWorkbench,
  ServerSidebar,
  type CenterView,
  type InspectorView
} from './components/workbench';
import { parseThemePreference, resolveTheme, type ThemePreference } from './lib/theme';
import { joinRemotePath } from './lib/remote-path';

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

const THEME_STORAGE_KEY = 'ai-ssh:theme-preference';

function getInitialThemePreference(): ThemePreference {
  return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
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
      const theme = resolveTheme(themePreference, media.matches);
      document.documentElement.classList.toggle('dark', theme === 'dark');
      document.documentElement.classList.toggle('green', theme === 'green');
      document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
      void window.aiSsh.setTitleBarTheme(theme);
    };
    applyTheme();
    window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    if (themePreference === 'system') {
      media.addEventListener('change', applyTheme);
      return () => media.removeEventListener('change', applyTheme);
    }
    return undefined;
  }, [themePreference]);

  function selectProfile(profile: ConnectionProfile): void {
    setSelectedProfileId(profile.id);
    setEditingId(profile.id);
    setForm(toProfileForm(profile));
    setMessage(undefined);
    setCenterView('terminal');
  }

  function createProfile(): void {
    setEditingId(undefined);
    setSelectedProfileId(undefined);
    setForm(DEFAULT_FORM);
    setMessage(undefined);
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

  async function exportProfiles(): Promise<void> {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await window.aiSsh.exportProfiles();
      if (result) {
        setMessage(`已导出 ${result.count} 个配置${result.includesSecrets ? '（包含敏感信息）' : '（不含密码和私钥）'}`);
      }
    } catch (error) {
      setMessage(`导出失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function importProfiles(): Promise<void> {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await window.aiSsh.importProfiles();
      if (result) {
        await refresh();
        const skipped = result.skippedCount ? `，跳过 ${result.skippedCount} 个重复配置` : '';
        setMessage(`已导入 ${result.importedCount} 个配置${skipped}${result.includedSecrets ? '，凭据已安全保存' : '，缺少的凭据请重新填写'}`);
      }
    } catch (error) {
      setMessage(`导入失败：${error instanceof Error ? error.message : String(error)}`);
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
    setMessage(undefined);
    try {
      await window.aiSsh.openSession(selectedProfileId, authorizationLevel);
      await refresh();
      setCenterView('terminal');
      setMessage('连接成功');
    } catch (error) {
      setMessage(`连接失败：${error instanceof Error ? error.message : String(error)}`);
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

  async function uploadFiles(files: LocalFileSelection[], remoteDirectory: string): Promise<void> {
    if (!activeSession || files.length === 0) return;
    setBusy(true);
    setMessage(undefined);
    try {
      for (const file of files) {
        await window.aiSsh.transferFile({
          sessionId: activeSession.id,
          localPath: file.path,
          remotePath: joinRemotePath(remoteDirectory, file.name),
          direction: 'upload'
        });
      }
      setMessage(`已上传 ${files.length} 个文件`);
    } catch (error) {
      setMessage(`上传失败：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function downloadFile(entry: RemoteFileEntry): Promise<void> {
    if (!activeSession || !selectedProfile?.localTransferRoot) return;
    const localPath = await window.aiSsh.pickDownloadTarget(
      selectedProfile.localTransferRoot,
      entry.name
    );
    if (!localPath) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await window.aiSsh.transferFile({
        sessionId: activeSession.id,
        localPath,
        remotePath: entry.path,
        direction: 'download'
      });
      setMessage('文件下载完成');
    } catch (error) {
      setMessage(`下载失败：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ai-ssh-workbench">
      <div className="window-titlebar" aria-hidden="true">
        <span>OrbitSSH</span>
      </div>
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
          busy={busy}
          onCreate={createProfile}
          onSelect={selectProfile}
          onImport={() => void importProfiles()}
          onExport={() => void exportProfiles()}
        />
        <CenterWorkbench
          profile={selectedProfile}
          session={activeSession}
          sessions={sessions.filter((session) => session.health !== 'disconnected')}
          form={form}
          authorizationLevel={authorizationLevel}
          history={visibleHistory}
          view={centerView}
          busy={busy}
          message={message}
          onViewChange={setCenterView}
          onFormChange={setForm}
          onAuthorizationLevelChange={setAuthorizationLevel}
          onConnect={() => void openSession()}
          onDisconnect={() => void closeSession()}
          onHealthCheck={() => void checkHealth()}
          onSave={() => void saveProfile()}
          onOpenTransfer={() => setInspectorView('transfer')}
        />
        <ActivityRail
          profile={selectedProfile}
          session={activeSession}
          history={visibleHistory}
          challenge={hostKeyChallenge}
          authorizationLevel={authorizationLevel}
          view={inspectorView}
          busy={busy}
          onViewChange={setInspectorView}
          onUploadFiles={uploadFiles}
          onDownloadFile={downloadFile}
          onConfirmHostKey={(challenge) => void confirmHostKeyTrust(challenge)}
        />
      </div>
    </div>
  );
}
