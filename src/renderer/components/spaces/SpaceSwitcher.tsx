import { useEffect, useRef, useState } from 'react';
import { ConnectionChips } from './ConnectionChips';
import { SpaceNameDialog } from './SpaceNameDialog';
import { useSpaces } from './useSpaces';
import './spaces.css';

const NAME_PROMPTED_KEY = 'spaceNamePrompted';
const DEFAULT_NAME = 'Default';

interface SpaceSwitcherProps {
  onManage: () => void;
}

/**
 * Header control showing the active space, with a menu to switch spaces,
 * create one, or open the manage view. Switching reloads the window.
 */
export function SpaceSwitcher({ onManage }: SpaceSwitcherProps) {
  const { api, spaces, active, loaded, refresh } = useSpaces();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [namePrompt, setNamePrompt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Make the active space visible everywhere: window title and accent colour.
  useEffect(() => {
    if (!active) return;
    document.title = `Git Analyzer · ${active.name}`;
    document.documentElement.style.setProperty('--space-color', active.color);
  }, [active]);

  // One-time invitation to name the migrated "Default" space.
  useEffect(() => {
    if (!api?.spaceSettings || !loaded || !active) return;
    if (spaces.length !== 1 || active.name !== DEFAULT_NAME) return;
    let cancelled = false;
    api.spaceSettings.get(NAME_PROMPTED_KEY).then((v) => {
      if (!cancelled && v === null) setNamePrompt(true);
    });
    return () => {
      cancelled = true;
    };
  }, [api, loaded, active, spaces.length]);

  // The manage view can add or delete spaces, so re-read the list on open.
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!api?.spaces || !active) return null;

  const switchTo = async (id: string) => {
    if (id === active.id) {
      setOpen(false);
      return;
    }
    setError(null);
    try {
      await api.spaces.switchTo(id); // The window reloads on success.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  };

  const markPrompted = () => api.spaceSettings.set(NAME_PROMPTED_KEY, '1');

  return (
    <div className="space-switcher" ref={rootRef}>
      <button
        type="button"
        className="space-switcher__button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Spaces keep separate repositories, connections and settings"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="space-switcher__dot" style={{ background: active.color }} aria-hidden="true" />
        <span className="space-switcher__name">{active.name}</span>
        <span aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="space-switcher__menu" role="menu" aria-label="Spaces">
          {spaces.map((s) => (
            <button
              key={s.id}
              type="button"
              role="menuitemradio"
              aria-checked={s.active}
              className="space-switcher__item"
              onClick={() => switchTo(s.id)}
            >
              <span className="space-switcher__dot" style={{ background: s.color }} aria-hidden="true" />
              <span className="space-switcher__item-name">{s.name}</span>
              <ConnectionChips connections={s.connections} />
              {s.active && <span aria-hidden="true">✓</span>}
            </button>
          ))}
          {error && <p className="space-switcher__error" role="alert">{error}</p>}
          <div className="space-switcher__separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="space-switcher__item"
            onClick={() => {
              setOpen(false);
              setCreating(true);
            }}
          >
            New space…
          </button>
          <button
            type="button"
            role="menuitem"
            className="space-switcher__item"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            Manage spaces…
          </button>
        </div>
      )}

      {creating && (
        <SpaceNameDialog
          title="New space"
          description="A space has its own repositories, commit history, connections (GitHub, Bitbucket, Snyk) and settings. You will switch to it straight away."
          submitLabel="Create and switch"
          onCancel={() => setCreating(false)}
          onSubmit={async (name, color) => {
            const created = await api.spaces.create(name, color);
            await refresh();
            await api.spaces.switchTo(created.id);
          }}
        />
      )}

      {namePrompt && (
        <SpaceNameDialog
          title="Name this space"
          description="Everything you have set up so far lives in a space. Give it a name so it is easy to tell apart from others, for example Work or Personal."
          submitLabel="Save name"
          cancelLabel="Not now"
          initialName={active.name}
          initialColor={active.color}
          showColor={false}
          onCancel={async () => {
            await markPrompted();
            setNamePrompt(false);
          }}
          onSubmit={async (name) => {
            await api.spaces.rename(active.id, name, active.color);
            await markPrompted();
            setNamePrompt(false);
            await refresh();
          }}
        />
      )}
    </div>
  );
}
