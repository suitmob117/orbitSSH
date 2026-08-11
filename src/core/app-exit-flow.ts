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
    void options.choosePolicy()
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

