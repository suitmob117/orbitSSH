import { FolderInput, PlugZap, Power, RefreshCw, Server } from 'lucide-react';
import type { AuthorizationLevel, ConnectionProfile, ConnectionSession } from '@shared/types';
import { Button, DangerButton, SecondaryButton, Select } from './ui';
import { cn } from '../lib/utils';

const AUTH_LEVEL_LABELS: Record<AuthorizationLevel, string> = {
  ask_every_time: '每次询问',
  auto_readonly: '自动只读',
  trusted_session: '信任会话'
};

const AUTH_LEVEL_TONES: Record<AuthorizationLevel, string> = {
  ask_every_time: 'authorization-normal',
  auto_readonly: 'authorization-readonly',
  trusted_session: 'authorization-trusted'
};

function SessionActionButton({
  label,
  tone = 'secondary',
  disabled,
  className,
  children,
  onClick
}: {
  label: string;
  tone?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
  onClick: () => void;
}): JSX.Element {
  const ActionButton = tone === 'primary' ? Button : tone === 'danger' ? DangerButton : SecondaryButton;
  return (
    <ActionButton
      type="button"
      className={cn('session-action-button', className)}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </ActionButton>
  );
}

function CodexAccessSwitch({ paused, onToggle }: { paused: boolean; onToggle: () => void }): JSX.Element {
  const label = paused ? '恢复 Codex 操作权' : '完全接管：暂停 Codex';
  return (
    <SecondaryButton
      type="button"
      role="switch"
      aria-checked={!paused}
      aria-label={label}
      title={label}
      className={cn('codex-access-switch', paused ? 'is-disconnected' : 'is-connected')}
      onClick={onToggle}
    >
      <span className="codex-switch-track" aria-hidden="true"><i /></span>
    </SecondaryButton>
  );
}

export function SessionHeader({
  profile,
  session,
  authorizationLevel,
  codexPaused,
  busy,
  onAuthorizationLevelChange,
  onToggleCodexPause,
  onHealthCheck,
  onConnect,
  onDisconnect,
  onOpenTransfer
}: {
  profile?: ConnectionProfile;
  session?: ConnectionSession;
  authorizationLevel: AuthorizationLevel;
  codexPaused: boolean;
  busy: boolean;
  onAuthorizationLevelChange: (value: AuthorizationLevel) => void;
  onToggleCodexPause: () => void;
  onHealthCheck: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onOpenTransfer: () => void;
}): JSX.Element {
  return (
    <section className="session-header workbench-panel">
      <div className="session-identity">
        <div className="server-orb"><Server /></div>
        <div>
          <h1>{profile?.name ?? '新建连接'}</h1>
          <p>{profile ? <><b>{profile.username}</b>@{profile.host} · 端口 {profile.port}</> : '填写服务器信息后保存连接'}</p>
        </div>
      </div>
      <div className="session-controls">
        <span className={cn('trust-state', session && 'is-trusted')}><i />{session ? '会话已建立' : '等待连接'}</span>
        <Select className={cn('authorization-select', AUTH_LEVEL_TONES[authorizationLevel])} value={authorizationLevel} onChange={(event) => onAuthorizationLevelChange(event.target.value as AuthorizationLevel)}>
          {Object.entries(AUTH_LEVEL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
        {session ? (
          <CodexAccessSwitch paused={codexPaused} onToggle={onToggleCodexPause} />
        ) : null}
        {session ? <SessionActionButton label="检查连接" disabled={busy} onClick={onHealthCheck}><RefreshCw /></SessionActionButton> : null}
        <SessionActionButton label="打开文件舱" onClick={onOpenTransfer} disabled={!profile}><FolderInput /></SessionActionButton>
        {session ? (
          <SessionActionButton label="关闭连接" tone="danger" onClick={onDisconnect}><Power /></SessionActionButton>
        ) : (
          <SessionActionButton label="连接服务器" tone="primary" onClick={onConnect} disabled={!profile || busy}><PlugZap /></SessionActionButton>
        )}
      </div>
    </section>
  );
}
