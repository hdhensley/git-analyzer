import { useState, useEffect } from 'react';
import type { ElectronAPI } from '../../shared/types/electron-api';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export function useElectronAPI(): ElectronAPI | null {
  const [api, setApi] = useState<ElectronAPI | null>(
    typeof window.electronAPI !== 'undefined' ? window.electronAPI : null
  );

  useEffect(() => {
    // If API is already available, no need to poll
    if (api) return;

    // Poll for API availability until it's ready
    const interval = setInterval(() => {
      if (typeof window.electronAPI !== 'undefined') {
        setApi(window.electronAPI);
        clearInterval(interval);
      }
    }, 100);

    // Cleanup on unmount
    return () => clearInterval(interval);
  }, [api]);

  return api;
}
