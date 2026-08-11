const SERVER_PATH_COLOR = '\x1b[38;2;112;207;255m';
const RESET_COLOR = '\x1b[0m';

// Common bash prompt form: [user@host /current/path]#
const BRACKETED_SHELL_PROMPT = /(\[[^\]\r\n]*@[^\s\]\r\n]+\s)([^\]\r\n]+)(\][#$])(?=\s|$)/g;

export function highlightServerPrompt(data: string): string {
  return data.replace(
    BRACKETED_SHELL_PROMPT,
    (_match, prefix: string, serverPath: string, suffix: string) =>
      `${prefix}${SERVER_PATH_COLOR}${serverPath}${RESET_COLOR}${suffix}`
  );
}
