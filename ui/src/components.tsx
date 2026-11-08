import { useState, type ReactNode } from 'react';
import type { RunActivity, RunModels, RunStatus } from '../../src/ui/api-types.ts';
import { shortModel } from '../../src/ui/models.ts';
import { formatPct, formatUsd } from './format.ts';

const STATUS_TEXT: Record<RunStatus, string> = {
  running: 'Running',
  finished: 'Finished',
  stopped: 'Stopped',
  unknown: 'Unknown',
};
// A symbol as well as a colour, so the status never relies on colour alone.
const STATUS_ICON: Record<RunStatus, string> = { running: '▶', finished: '✓', stopped: '■', unknown: '?' };

export function StatusBadge({ status, activity }: { status: RunStatus; activity?: RunActivity }) {
  const sub = status === 'running' && activity === 'waiting_on_batch' ? ' · waiting on batch' : '';
  return (
    <span className={`badge badge-${status}`}>
      <span aria-hidden="true" className={status === 'running' ? 'pulse' : undefined}>
        {STATUS_ICON[status]}
      </span>{' '}
      {STATUS_TEXT[status]}
      {sub}
    </span>
  );
}

export function ModeTag({ mode }: { mode: string }) {
  return <span className="tag">{mode}</span>;
}

/** "haiku → sonnet · jev" (writer → escalation · decision models). */
export function ModelsLine({ models, mode }: { models: RunModels; mode: string }) {
  if (mode === 'baseline') return <span className="models">{shortModel(models.writer)}</span>;
  const deciders = models.triage === models.verify ? shortModel(models.triage) : `${shortModel(models.triage)} + ${shortModel(models.verify)}`;
  return (
    <span className="models" title={`writer ${models.writer}, escalation ${models.escalation}, triage ${models.triage}, verify ${models.verify}`}>
      {shortModel(models.writer)} → {shortModel(models.escalation)} · {deciders}
    </span>
  );
}

export function ProgressBar({ value, label, tone = 'accent', indeterminate = false }: { value: number | null; label: string; tone?: 'accent' | 'ok' | 'warn' | 'danger'; indeterminate?: boolean }) {
  const pct = value === null ? 0 : Math.round(value * 1000) / 10;
  return (
    <div
      className={`bar bar-${tone}${indeterminate ? ' bar-estimate' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(value === null ? {} : { 'aria-valuenow': pct, 'aria-valuetext': `${formatPct(value)}` })}
    >
      <div className="bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function SpendVsCap({ spent, cap, scope }: { spent: number; cap: number | null; scope: 'run' | 'bench' | null }) {
  const over = cap !== null && spent > cap;
  return (
    <div className="spend-cap">
      <span>
        <strong>{formatUsd(spent)}</strong>
        {cap !== null ? (
          <span className="muted">
            {' '}
            of {formatUsd(cap)}
            {scope === 'bench' ? ' (bench cap, shared)' : ' cap'}
          </span>
        ) : (
          <span className="muted"> · no cap</span>
        )}
      </span>
      {cap !== null && cap > 0 && (
        <ProgressBar value={Math.min(1, spent / cap)} label="Spend against cap" tone={over ? 'danger' : spent / cap > 0.8 ? 'warn' : 'accent'} />
      )}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 2000);
  };
  return (
    <button type="button" className="button" onClick={() => void copy()} aria-label={`${label}: ${text}`}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select and copy' : label}
      <span className="sr-only" aria-live="polite">
        {state === 'copied' ? 'Copied to clipboard' : ''}
      </span>
    </button>
  );
}

export function Card({ title, children, className = '', id }: { title: string; children: ReactNode; className?: string; id?: string }) {
  const headingId = id ?? `card-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section className={`card ${className}`} aria-labelledby={headingId}>
      <h2 id={headingId} className="card-title">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="note note-error" role="status">
      Could not refresh: {error}. Showing the last data received.
    </p>
  );
}

export function LiveIndicator({ updatedAt, paused, now }: { updatedAt: number | null; paused: boolean; now: number }) {
  const text = paused ? 'Paused while this tab is hidden' : updatedAt ? `Updated ${Math.max(0, Math.round((now - updatedAt) / 1000))} s ago` : 'Loading…';
  return <span className="live muted">{text}</span>;
}
