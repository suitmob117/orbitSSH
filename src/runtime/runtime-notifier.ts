import { spawn } from 'node:child_process';

export interface ApprovalNotifier {
  /** 通知接口故意不接收动作、主机或命令，避免敏感信息进入系统通知。 */
  notifyPendingApproval(): void;
}

export class WindowsApprovalNotifier implements ApprovalNotifier {
  notifyPendingApproval(): void {
    if (process.platform !== 'win32') return;
    const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>OrbitSSH 等待批准</text><text>一个服务器会话有受控操作等待处理，请打开 OrbitSSH 查看详情。</text></binding></visual></toast>')
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('OrbitSSH').Show($toast)
`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      encoded
    ], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore'
    });
    child.on('error', () => undefined);
    child.unref();
  }
}
