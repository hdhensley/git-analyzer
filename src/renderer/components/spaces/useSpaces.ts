import { useCallback, useEffect, useState } from 'react';
import { useElectronAPI } from '../../hooks';
import type { SpaceSummary } from '../../../shared/types';

/** Loads the list of spaces and which one is active. */
export function useSpaces() {
  const api = useElectronAPI();
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!api?.spaces) return;
    try {
      const list = await api.spaces.list();
      if (Array.isArray(list)) setSpaces(list);
    } catch (err) {
      console.error('Failed to load spaces:', err);
    } finally {
      setLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const active = spaces.find((s) => s.active) ?? null;
  return { api, spaces, active, loaded, refresh };
}
