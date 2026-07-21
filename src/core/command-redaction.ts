import { parse } from 'shell-quote';

import { redact } from './redaction';

const SENSITIVE_COMMAND = '[REDACTED:SENSITIVE_COMMAND]';
const SENSITIVE_HEADER = /(?<![!#$%&'*+\-.^_`|~0-9A-Za-z])(?:cookie|authorization)\s*:/i;
const ATTACHED_HEADER = /^(?:-H|--header=)(?:cookie|authorization)\s*:/i;

export function redactCommand(command: string): string {
  try {
    const hasSensitiveHeader = parse(command).some(
      (entry) =>
        typeof entry === 'string' &&
        (SENSITIVE_HEADER.test(entry) || ATTACHED_HEADER.test(entry))
    );
    return hasSensitiveHeader ? SENSITIVE_COMMAND : redact(command);
  } catch {
    return SENSITIVE_HEADER.test(command) || ATTACHED_HEADER.test(command)
      ? SENSITIVE_COMMAND
      : redact(command);
  }
}
