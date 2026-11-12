import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { SPACE_COLOR_CHOICES } from './spaceColors';

interface SpaceNameDialogProps {
  title: string;
  description: string;
  submitLabel: string;
  initialName?: string;
  initialColor?: string;
  /** Show the colour picker (the first-run naming prompt only asks for a name). */
  showColor?: boolean;
  cancelLabel?: string;
  onSubmit: (name: string, color: string) => Promise<void>;
  onCancel: () => void;
}

/** Modal asking for a space name (and optionally a colour). */
export function SpaceNameDialog({
  title,
  description,
  submitLabel,
  initialName = '',
  initialColor = SPACE_COLOR_CHOICES[0],
  showColor = true,
  cancelLabel = 'Cancel',
  onSubmit,
  onCancel,
}: SpaceNameDialogProps) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(initialColor);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name, color);
    } catch (err) {
      // Electron wraps IPC errors; keep only the human-readable part.
      const message = err instanceof Error ? err.message : String(err);
      setError(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      setBusy(false);
    }
  };

  return (
    <div className="space-dialog__overlay" onClick={onCancel}>
      <form
        className="space-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="space-dialog-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h3 id="space-dialog-title" className="space-dialog__title">{title}</h3>
        <p className="space-dialog__desc">{description}</p>

        <label className="space-dialog__label" htmlFor="space-dialog-name">Name</label>
        <input
          id="space-dialog-name"
          ref={inputRef}
          className="space-dialog__input"
          type="text"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Work or Personal"
        />

        {showColor && (
          <>
            <span className="space-dialog__label" id="space-dialog-color">Colour</span>
            <div className="space-dialog__swatches" role="radiogroup" aria-labelledby="space-dialog-color">
              {SPACE_COLOR_CHOICES.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={`Colour ${c}`}
                  className={`space-dialog__swatch ${color === c ? 'space-dialog__swatch--selected' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </>
        )}

        {error && <p className="space-dialog__error" role="alert">{error}</p>}

        <div className="space-dialog__actions">
          <button type="button" className="space-dialog__btn" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button type="submit" className="space-dialog__btn space-dialog__btn--primary" disabled={busy || !name.trim()}>
            {busy ? 'Working…' : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
