const SECRET_PATTERNS = [
  /(password\s*[=:]\s*)[^\s'"`]+/gi,
  /(token\s*[=:]\s*)[^\s'"`]+/gi,
  /(api[_-]?key\s*[=:]\s*)[^\s'"`]+/gi,
  /(secret\s*[=:]\s*)[^\s'"`]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];

export function redact(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, '$1[REDACTED]'), value);
}

export function tail(value: string, maxChars = 12000): string {
  const redacted = redact(value);
  return redacted.length > maxChars ? redacted.slice(redacted.length - maxChars) : redacted;
}
