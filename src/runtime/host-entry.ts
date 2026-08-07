import { RuntimeHost } from './runtime-host';
import { loadRuntimeAuthTokens } from './runtime-auth';

const host = new RuntimeHost({
  authTokens: await loadRuntimeAuthTokens(),
  endpoint: process.env.ORBITSSH_RUNTIME_ENDPOINT,
  onShutdown: () => process.exit(0)
});

try {
  await host.start();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    process.exit(0);
  }
  throw error;
}

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void host.stop().finally(() => process.exit(0));
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
