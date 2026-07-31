/**
 * Theme boot-time application.
 *
 * `index.html` ships with `class="dark"` so the very first paint is dark —
 * but the user's persisted choice (Settings → General → Theme) may be light
 * or "system". This helper runs before React mounts, fetches the stored
 * theme via the same `/api/settings/:key` endpoint Settings uses, and toggles
 * the `dark` class on `<html>` to match.
 *
 * The call is fire-and-forget: a missing setting or unreachable server is
 * treated as "system", and we fall back to the OS preference. The Settings
 * view also re-applies the class on change, so this is purely about
 * eliminating the dark→light flicker on cold boot.
 */

import { api } from './api';
import { useUiStore, type ThemePreference } from '@/renderer/store/ui';

interface SettingValueResponse {
  value: string | null;
}

function parseTheme(raw: string | null): ThemePreference {
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  return 'system';
}

export function applyThemeClass(theme: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const wantsDark =
    theme === 'dark' ||
    (theme === 'system' &&
      Boolean(
        typeof window !== 'undefined' &&
          window.matchMedia?.('(prefers-color-scheme: dark)').matches,
      ));
  root.classList.toggle('dark', wantsDark);
}

export async function applyStoredTheme(): Promise<void> {
  // Default to whatever's already in the store (usually "system") so the
  // store stays consistent even if the network call fails.
  let theme: ThemePreference = useUiStore.getState().theme;
  try {
    const res = await api.get<SettingValueResponse>('/api/settings/theme');
    theme = parseTheme(res.value);
  } catch {
    // Server not reachable / setting missing → keep the in-memory default.
  }
  useUiStore.setState({ theme });
  applyThemeClass(theme);
}
