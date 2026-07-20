const SECRET_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  {
    pattern: /((?:"password"|'password'|password)\s*[=:]\s*)(?:(["'])(?:\\.|[^\\])*?\2|[^\s'"`]+)/gi,
    replacement: '$1$2[REDACTED]$2'
  },
  {
    pattern: /((?:"token"|'token'|token)\s*[=:]\s*)(?:(["'])(?:\\.|[^\\])*?\2|[^\s'"`]+)/gi,
    replacement: '$1$2[REDACTED]$2'
  },
  {
    pattern: /((?:"api[_-]?key"|'api[_-]?key'|api[_-]?key)\s*[=:]\s*)(?:(["'])(?:\\.|[^\\])*?\2|[^\s'"`]+)/gi,
    replacement: '$1$2[REDACTED]$2'
  },
  {
    pattern: /((?:"secret"|'secret'|secret)\s*[=:]\s*)(?:(["'])(?:\\.|[^\\])*?\2|[^\s'"`]+)/gi,
    replacement: '$1$2[REDACTED]$2'
  },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED]'
  }
];

export function redact(value: string): string {
  return SECRET_PATTERNS.reduce(
    (text, { pattern, replacement }) => text.replace(pattern, replacement),
    value
  );
}

export function tail(value: string, maxChars = 12000): string {
  const redacted = redact(value);
  return redacted.length > maxChars ? redacted.slice(redacted.length - maxChars) : redacted;
}
