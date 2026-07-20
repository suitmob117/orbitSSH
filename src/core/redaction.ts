const SECRET_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /(password\s*[=:]\s*)[^\s'"`]+/gi, replacement: '$1[REDACTED]' },
  { pattern: /(token\s*[=:]\s*)[^\s'"`]+/gi, replacement: '$1[REDACTED]' },
  { pattern: /(api[_-]?key\s*[=:]\s*)[^\s'"`]+/gi, replacement: '$1[REDACTED]' },
  { pattern: /(secret\s*[=:]\s*)[^\s'"`]+/gi, replacement: '$1[REDACTED]' },
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
