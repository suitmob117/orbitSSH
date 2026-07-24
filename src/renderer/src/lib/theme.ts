import type { AppTheme } from '@shared/types';

export type ThemePreference = 'system' | 'light' | 'dark' | 'green';
export type ResolvedTheme = AppTheme;

export function parseThemePreference(value: string | null): ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark' || value === 'green'
    ? value
    : 'green';
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference !== 'system') return preference;
  return systemPrefersDark ? 'dark' : 'light';
}
