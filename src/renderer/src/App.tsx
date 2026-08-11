import { useEffect, useMemo, useRef, useState } from 'react';
import type {
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
import { getMessageAutoDismissMs } from './lib/message-lifecycle';
import type { MessageKind } from './lib/message-lifecycle';

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

function mergeCodrivingActions(current: CodrivingAction[], incoming: CodrivingAction[]): CodrivingAction[] {
  const actions = new Map(current.map((action) => [action.id, action]));
  for (const action of incoming) {
    const existing = actions.get(action.id);
    if (!existing || action.sequence >= existing.sequence) actions.set(action.id, action);
  }
  return [...actions.values()].sort((left, right) => left.sequence - right.sequence);
}

export function App(): JSX.Element {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [sessions, setSessions] = useState<ConnectionSession[]>([]);
  const [history, setHistory] = useState<CommandRecord[]>([]);
  const [hostKeyChallenges, setHostKeyChallenges] = useState<HostKeyTrustChallenge[]>([]);
  const [codrivingActions, setCodrivingActions] = useState<CodrivingAction[]>([]);
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [codexPaused, setCodexPaused] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  const [editingId, setEditingId] = useState<string>();
  const [form, setForm] = useState<ConnectionProfileInput>(DEFAULT_FORM);
  const [authorizationLevel, setAuthorizationLevel] = useState<AuthorizationLevel>('ask_every_time');
  const [centerView, setCenterView] = useState<CenterView>('terminal');
  const [inspectorView, setInspectorView] = useState<InspectorView>('activity');
  const [themePreference, setThemePreference] = useState<ThemePreference>(getInitialThemePreference);
  const [busy, setBusy] = useState(false);
  const [messageState, setMessageState] = useState<{ id: number; text: string; kind: MessageKind }>();
  const actionCacheRef = useRef(new Map<string, CodrivingAction[]>());
  const message = messageState?.text;

  function setMessage(text?: string, kind: MessageKind = 'success'): void {
    setMessageState((current) => text
      ? { id: (current?.id ?? 0) + 1, text, kind }
      : undefined
    );
  }

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
    const unsubscribe = window.aiSsh.onApprovalAttention(setPendingApprovalCount);
    void window.aiSsh.getApprovalAttentionCount().then(setPendingApprovalCount).catch(() => undefined);
    return unsubscribe;
  }, []);

  useEffect(() => {
    const delay = getMessageAutoDismissMs(messageState?.kind);
    if (delay === undefined) return;
    const messageId = messageState!.id;
    const timer = window.setTimeout(() => {
      setMessageState((current) => current?.id === messageId ? undefined : current);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [messageState]);

  useEffect(() => {
    if (!activeSession) {
      setCodrivingActions([]);
      setCodexPaused(false);
      return;
    }
    setAuthorizationLevel(activeSession.authorizationLevel);
    const sessionId = activeSession.id;
    const cached = actionCacheRef.current.get(sessionId) ?? [];
    setCodrivingActions(cached);
    const afterSequence = cached.at(-1)?.sequence ?? 0;
    let cancelled = false;
    void Promise.all([
      window.aiSsh.listCodrivingActions(sessionId, afterSequence),
      window.aiSsh.isCodexPaused(sessionId)
    ]).then(([actions, paused]) => {
      if (cancelled) return;
      const current = actionCacheRef.current.get(sessionId) ?? cached;
      const merged = mergeCodrivingActions(current, actions);
      actionCacheRef.current.set(sessionId, merged);
      setCodrivingActions(merged);
      setCodexPaused(paused);
    });
    return () => { cancelled = true; };
  }, [activeSession?.id]);

  useEffect(() => {
    const removeActionListener = window.aiSsh.onCodrivingAction((action) => {
      const cached = actionCacheRef.current.get(action.sessionId) ?? [];
      const merged = mergeCodrivingActions(cached, [action]);
      actionCacheRef.current.set(action.sessionId, merged);
      if (action.sessionId === activeSession?.id) {
        setCodrivingActions(merged);
        if (action.kind === 'control') {
          void window.aiSsh.isCodexPaused(action.sessionId).then(setCodexPaused);
        }
      }
      void refresh();
    });
    const removeSessionListener = window.aiSsh.onSessionUpdated((session) => {
      setSessions((items) => {
        const exists = items.some((item) => item.id === session.id);
        return exists ? items.map((item) => item.id === session.id ? session : item) : [...items, session];
      });
      if (session.id === activeSession?.id) setAuthorizationLevel(session.authorizationLevel);
    });
    return () => {
      removeActionListener();
      removeSessionListener();
    };
  }, [activeSession?.id]);

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
      setMessage(error instanceof Error ? error.message : String(error), 'error');
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
      setMessage(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error');
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
      setMessage(`导入失败：${error instanceof Error ? error.message : String(error)}`, 'error');
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
      setMessage('主机指纹已确认，请再次连接以建立会话', 'blocking');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), 'error');
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
      setMessage(`连接失败：${error instanceof Error ? error.message : String(error)}`, 'error');
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
      setMessage(
        `健康检查完成：${session.health === 'connected' ? '连接正常' : '连接异常'}`,
        session.health === 'connected' ? 'success' : 'error'
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function changeAuthorizationLevel(level: AuthorizationLevel): Promise<void> {
    setAuthorizationLevel(level);
    if (!activeSession) return;
    setBusy(true);
    try {
      const session = await window.aiSsh.setSessionAuthorization({
        sessionId: activeSession.id,
        authorizationLevel: level,
        trustedUntil: level === 'trusted_session'
          ? new Date(Date.now() + 60 * 60_000).toISOString()
          : undefined
      });
      setSessions((items) => items.map((item) => item.id === session.id ? session : item));
      setMessage(level === 'trusted_session' ? '已信任本次 Codex 会话 1 小时' : 'Codex 授权模式已更新');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function decideCodrivingAction(action: CodrivingAction, approve: boolean): Promise<void> {
    setBusy(true);
    try {
      const approval = { actionId: action.id, digest: action.digest };
      if (approve) await window.aiSsh.approveCodrivingAction(approval);
      else await window.aiSsh.rejectCodrivingAction(approval);
      if (activeSession) await refreshCodrivingActions(activeSession.id);
      await refresh();
      setMessage(approve ? '操作已批准并执行' : '操作已拒绝');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function toggleCodexPause(): Promise<void> {
    if (!activeSession) return;
    setBusy(true);
    try {
      if (codexPaused) await window.aiSsh.resumeCodex(activeSession.id);
      else await window.aiSsh.pauseCodex(activeSession.id);
      setCodexPaused(!codexPaused);
      await refreshCodrivingActions(activeSession.id);
      setMessage(codexPaused ? 'Codex 操作权已恢复' : '已完全接管，Codex 新操作已暂停');
    } finally {
      setBusy(false);
    }
  }

  async function refreshCodrivingActions(sessionId: string): Promise<void> {
    const cached = actionCacheRef.current.get(sessionId) ?? [];
    const afterSequence = cached.at(-1)?.sequence ?? 0;
    const incoming = await window.aiSsh.listCodrivingActions(sessionId, afterSequence);
    const current = actionCacheRef.current.get(sessionId) ?? cached;
    const merged = mergeCodrivingActions(current, incoming);
    actionCacheRef.current.set(sessionId, merged);
    setCodrivingActions(merged);
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
      setMessage(`上传失败：${error instanceof Error ? error.message : String(error)}`, 'error');
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
      setMessage(`下载失败：${error instanceof Error ? error.message : String(error)}`, 'error');
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
        pendingApprovalCount={pendingApprovalCount}
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
          history={visibleHistory}
          view={centerView}
          busy={busy}
          message={message}
          onDismissMessage={() => setMessage(undefined)}
          authorizationLevel={authorizationLevel}
          onViewChange={setCenterView}
          onFormChange={setForm}
          codexPaused={codexPaused}
          onAuthorizationLevelChange={(level) => void changeAuthorizationLevel(level)}
          onToggleCodexPause={() => void toggleCodexPause()}
          onConnect={() => void openSession()}
          onDisconnect={() => void closeSession()}
          onHealthCheck={() => void checkHealth()}
          onSave={() => void saveProfile()}
          onOpenTransfer={() => setInspectorView('transfer')}
          onCommandRecorded={(record) => setHistory((items) => [
            ...items.filter((item) => item.id !== record.id),
            record
          ])}
        />
        <ActivityRail
          profile={selectedProfile}
          session={activeSession}
          history={visibleHistory}
          actions={codrivingActions}
          challenge={hostKeyChallenge}
          view={inspectorView}
          busy={busy}
          onViewChange={setInspectorView}
          onUploadFiles={uploadFiles}
          onDownloadFile={downloadFile}
          onConfirmHostKey={(challenge) => void confirmHostKeyTrust(challenge)}
          onApproveAction={(action) => void decideCodrivingAction(action, true)}
          onRejectAction={(action) => void decideCodrivingAction(action, false)}
        />
      </div>
    </div>
  );
}
