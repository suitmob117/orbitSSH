const SECRET_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  {
    pattern: /((?:"password"|'password'|password)\s*[=:]\s*)(?:(["'])(?:\\.|[^\\])*?\2|[^\s'"`]+)/gi,
    replacement: '$1$2[REDACTED]$2'
  },
  {
    pattern: /((?:"access_token"|'access_token'|access_token)\s*[=:]\s*)(?:(["'])(?:\\.|[^\\])*?\2|[^\s'"`]+)/gi,
    replacement: '$1$2[REDACTED]$2'
  },
  {
    pattern: /((?:"refresh_token"|'refresh_token'|refresh_token)\s*[=:]\s*)(?:(["'])(?:\\.|[^\\])*?\2|[^\s'"`]+)/gi,
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
    pattern: /((?:"client_secret"|'client_secret'|client_secret)\s*[=:]\s*)(?:(["'])(?:\\.|[^\\])*?\2|[^\s'"`]+)/gi,
    replacement: '$1$2[REDACTED]$2'
  },
  {
    pattern: /((?:"secret"|'secret'|secret)\s*[=:]\s*)(?:(["'])(?:\\.|[^\\])*?\2|[^\s'"`]+)/gi,
    replacement: '$1$2[REDACTED]$2'
  },
  {
    pattern: /("authorization"\s*:\s*")(?:\\.|[^"\\])*"/gi,
    replacement: '$1[REDACTED]"'
  },
  {
    pattern: /("cookie"\s*:\s*")(?:\\.|[^"\\])*"/gi,
    replacement: '$1[REDACTED]"'
  },
  {
    pattern: /(?<![!#$%&'*+\-.^_`|~0-9A-Za-z])(authorization\s*:\s*bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,
    replacement: '$1[REDACTED]'
  },
  { pattern: /^(cookie\s*:\s*)[^\r\n]+/gim, replacement: '$1[REDACTED]' },
  {
    pattern: /("cookie\s*:\s*)(?:\\.|[^"\\])*"/gi,
    replacement: '$1[REDACTED]"'
  },
  {
    pattern: /('cookie\s*:\s*)(?:\\.|[^'\\])*'/gi,
    replacement: "$1[REDACTED]'"
  },
  {
    pattern: /(curl\s+-H\s+)(cookie\s*:\s*)[^\s;&|<>]+/gi,
    replacement: '$1$2[REDACTED]'
  },
  {
    pattern: /(?<![!#$%&'*+\-.^_`|~0-9A-Za-z])(cookie\s*:\s*)[!#$%&'*+\-.^_`|~0-9A-Za-z]+=(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;()\[\]{},'"`]*)(?:;\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;()\[\]{},'"`]*))*/gi,
    replacement: '$1[REDACTED]'
  },
  {
    pattern: /(postgres(?:ql)?:\/\/[^\s/:@'"`]+:)[^\s/@'"`]+@/gi,
    replacement: '$1[REDACTED]@'
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
