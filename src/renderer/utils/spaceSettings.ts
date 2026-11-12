import type { ElectronAPI } from '../../shared/types/electron-api';

// Per-space settings live in the space's database (not renderer localStorage,
// which is shared by every space). Existing installs kept these values in
// localStorage, so the first read in the default space adopts the old value.
const DEFAULT_SPACE_ID = 'default';

export async function loadSpaceSetting(
  api: ElectronAPI,
  key: string,
  legacyLocalStorageKey?: string
): Promise<string | null> {
  try {
    const stored = (await api.spaceSettings?.get(key)) ?? null;
    if (stored !== null || !legacyLocalStorageKey) return stored;

    // Only the default space owns pre-spaces values.
    const active = await api.spaces?.getActive();
    if (active?.id !== DEFAULT_SPACE_ID) return null;
    const legacy = window.localStorage.getItem(legacyLocalStorageKey);
    if (legacy === null) return null;
    await api.spaceSettings.set(key, legacy);
    window.localStorage.removeItem(legacyLocalStorageKey);
    return legacy;
  } catch {
    return null;
  }
}

export async function saveSpaceSetting(
  api: ElectronAPI,
  key: string,
  value: string | null
): Promise<void> {
  try {
    await api.spaceSettings?.set(key, value);
  } catch {
    // The setting just won't persist; nothing depends on it succeeding.
  }
}
