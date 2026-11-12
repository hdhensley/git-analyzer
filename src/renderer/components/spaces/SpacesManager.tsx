import { useState } from 'react';
import { ConnectionChips } from './ConnectionChips';
import { SpaceNameDialog } from './SpaceNameDialog';
import { useSpaces } from './useSpaces';
import type { SpaceSummary } from '../../../shared/types';
import './spaces.css';

const cleanError = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  );

/** Manage view: rename, recolour, create and delete spaces. */
export function SpacesManager() {
  const { api, spaces, refresh } = useSpaces();
  const [editing, setEditing] = useState<SpaceSummary | null>(null);
  const [deleting, setDeleting] = useState<SpaceSummary | null>(null);
  const [typed, setTyped] = useState('');
  const [creating, setCreating] = useState(false);
  const [duplicating, setDuplicating] = useState<SpaceSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  if (!api?.spaces) return null;

  const exportSpace = async (space: SpaceSummary) => {
    setError(null);
    setNotice(null);
    try {
      const saved = await api.spaces.export(space.id);
      if (saved) setNotice(`Exported “${space.name}” to ${saved}. Saved connections are not included.`);
    } catch (err) {
      setError(cleanError(err));
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setWorking(true);
    setError(null);
    try {
      await api.spaces.delete(deleting.id);
      setDeleting(null);
      setTyped('');
      await refresh();
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="spaces-manager">
      <h2>Spaces</h2>
      <p className="spaces-manager__intro">
        A space is a separate setup with its own repositories, commit history, connections
        (GitHub, Bitbucket, Snyk) and settings. Use one for work and another for personal projects.
        Only the active space syncs, and switching reloads the app.
      </p>

      {error && <p className="space-dialog__error" role="alert">{error}</p>}
      {notice && <p className="spaces-manager__notice" role="status">{notice}</p>}

      <ul className="spaces-manager__list">
        {spaces.map((s) => (
          <li key={s.id} className="spaces-manager__row">
            <span className="space-switcher__dot" style={{ background: s.color }} aria-hidden="true" />
            <span className="spaces-manager__name">
              {s.name}
              {s.active && <span className="spaces-manager__badge">Active</span>}
              <ConnectionChips connections={s.connections} showEmpty />
            </span>
            <span className="spaces-manager__actions">
              <button type="button" className="space-dialog__btn" onClick={() => setEditing(s)}>
                Rename
              </button>
              <button
                type="button"
                className="space-dialog__btn"
                title="Copy this space's repositories and history into a new space (connections are not copied)"
                onClick={() => setDuplicating(s)}
              >
                Duplicate
              </button>
              <button
                type="button"
                className="space-dialog__btn"
                title="Save this space's database to a file (connections are not included)"
                onClick={() => exportSpace(s)}
              >
                Export
              </button>
              <button
                type="button"
                className="space-dialog__btn space-dialog__btn--danger"
                disabled={s.active}
                title={s.active ? 'Switch to another space to delete this one' : undefined}
                onClick={() => {
                  setTyped('');
                  setError(null);
                  setDeleting(s);
                }}
              >
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>

      <button type="button" className="space-dialog__btn space-dialog__btn--primary" onClick={() => setCreating(true)}>
        New space…
      </button>

      {editing && (
        <SpaceNameDialog
          title="Rename space"
          description="Change the name or colour of this space."
          submitLabel="Save"
          initialName={editing.name}
          initialColor={editing.color}
          onCancel={() => setEditing(null)}
          onSubmit={async (name, color) => {
            await api.spaces.rename(editing.id, name, color);
            setEditing(null);
            await refresh();
            // Title and accent colour belong to the active space; reload to refresh them.
            if (editing.active) window.location.reload();
          }}
        />
      )}

      {duplicating && (
        <SpaceNameDialog
          title={`Duplicate “${duplicating.name}”`}
          description="The copy gets this space's repositories, commit history and settings. Saved connections are not copied, so you connect the copy separately."
          submitLabel="Duplicate"
          initialName={`${duplicating.name} copy`}
          initialColor={duplicating.color}
          onCancel={() => setDuplicating(null)}
          onSubmit={async (name, color) => {
            await api.spaces.duplicate(duplicating.id, name, color);
            setDuplicating(null);
            await refresh();
          }}
        />
      )}

      {creating && (
        <SpaceNameDialog
          title="New space"
          description="Create an empty space. Switch to it from the header menu when you are ready."
          submitLabel="Create"
          onCancel={() => setCreating(false)}
          onSubmit={async (name, color) => {
            await api.spaces.create(name, color);
            setCreating(false);
            await refresh();
          }}
        />
      )}

      {deleting && (
        <div className="space-dialog__overlay" onClick={() => setDeleting(null)}>
          <div
            className="space-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="space-delete-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="space-delete-title" className="space-dialog__title">Delete “{deleting.name}”?</h3>
            <p className="space-dialog__desc">
              This permanently deletes the space&apos;s database (imported repositories, commit
              history, cached Snyk data and settings) and its saved connections. Repositories on
              your disk are not touched. This cannot be undone.
            </p>
            <label className="space-dialog__label" htmlFor="space-delete-confirm">
              Type <strong>{deleting.name}</strong> to confirm
            </label>
            <input
              id="space-delete-confirm"
              className="space-dialog__input"
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
            />
            {error && <p className="space-dialog__error" role="alert">{error}</p>}
            <div className="space-dialog__actions">
              <button type="button" className="space-dialog__btn" onClick={() => setDeleting(null)} disabled={working}>
                Cancel
              </button>
              <button
                type="button"
                className="space-dialog__btn space-dialog__btn--danger"
                disabled={working || typed.trim() !== deleting.name}
                onClick={confirmDelete}
              >
                {working ? 'Deleting…' : 'Delete space'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
