export interface AppExitEvent {
  preventDefault(): void;
}

export interface AppExitFlowOptions {
  hasRuntime(): boolean;
  choosePolicy(): Promise<boolean>;
  closeRuntime(): Promise<void>;
  allowQuit(): void;
  quit(): void;
  reportError(error: unknown): void;
}

export interface AppExitFlow {
  onWindowClose(event: AppExitEvent): void;
  onBeforeQuit(event: AppExitEvent): void;
}

export function createAppExitFlow(options: AppExitFlowOptions): AppExitFlow {
  let prompting = false;
  let quitAllowed = false;

  const interceptExit = (event: AppExitEvent): void => {
    if (quitAllowed || !options.hasRuntime()) return;

    event.preventDefault();
    if (prompting) return;

    prompting = true;
    // 30 秒超时：如果用户未响应策略选择弹窗，默认关闭全部并退出。
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 30_000));
    void Promise.race([options.choosePolicy(), timeout])
      .then(async (confirmed) => {
        if (!confirmed) return;
        await options.closeRuntime();
        quitAllowed = true;
        options.allowQuit();
        options.quit();
      })
      .catch(options.reportError)
      .finally(() => {
        prompting = false;
      });
  };

  return {
    onWindowClose: interceptExit,
    onBeforeQuit: interceptExit
  };
}

