import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { runHref } from '../hooks.ts';

// Pieces shared by the two review pages (closed-choice / open rows, and extraction fields).

export async function readError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    return (JSON.parse(text) as { error?: string }).error ?? `HTTP ${res.status}`;
  } catch {
    return text.trim() || `HTTP ${res.status}`;
  }
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

export function Crumbs({ id }: { id: string }) {
  return (
    <p className="crumbs small">
      <a href="#/">All runs</a> / <a href={runHref(id)}>{id}</a> / Review
    </p>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useMemo(() => `dlg-${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`, [title]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="modal" aria-labelledby={titleId} onClose={onClose}>
      <div className="modal-head">
        <h2 id={titleId} className="card-title">
          {title}
        </h2>
        <button type="button" className="button" onClick={onClose} aria-label="Close">
          Esc
        </button>
      </div>
      {open && children}
    </dialog>
  );
}

export function NoteForm({ max, initial, hasDecision, onSave }: { max: number; initial: string; hasDecision: boolean; onSave: (note: string) => void }) {
  const [text, setText] = useState(initial);
  return (
    <form
      className="picker"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(text);
      }}
    >
      <label htmlFor="note-input" className="small">
        {hasDecision ? 'Saved with your decision on this row.' : 'Kept until you accept or override this row, then saved with it.'} Enter saves.
      </label>
      <textarea
        id="note-input"
        className="text-input"
        autoFocus
        rows={3}
        maxLength={max}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSave(text);
          }
        }}
      />
      <button type="submit" className="button button-primary">
        Save note
      </button>
    </form>
  );
}
