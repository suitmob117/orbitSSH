import type { AiSshApi } from '@shared/types';

declare global {
  interface Window {
    aiSsh: AiSshApi;
  }
}
