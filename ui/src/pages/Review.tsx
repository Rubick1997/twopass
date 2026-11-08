import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type {
  DecisionBody,
  OutputsResponse,
  OverrideResponse,
  ReviewFilter,
  ReviewResponse,
  ReviewRow,
} from '../../../src/ui/api-types.ts';
import { shortModel } from '../../../src/ui/models.ts';
import { ProgressBar } from '../components.tsx';
import { formatCount, formatPct, formatTime, formatUsd } from '../format.ts';
import { runHref } from '../hooks.ts';
import {
  adjustTotals,
  announce,
  applyDecision,
  decisionFor,
  FILTER_TEXT,
  FILTERS,
  filterLabels,
  isTypingTarget,
  keyToAction,
  nextFilter,
  nextUnreviewed,
  SHORTCUTS,
} from '../review.ts';

// The review queue: flagged rows one by one, accept or override, keyboard first.
// Decisions are shown at once (optimistic) and rolled back with a visible error if the POST fails.

const REFRESH_MS = 5000;

async function readError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    return (JSON.parse(text) as { error?: string }).error ?? `HTTP ${res.status}`;
  } catch {
    return text.trim() || `HTTP ${res.status}`;
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

interface SaveError {
  rowId: string;
  message: string;
  body: DecisionBody;
}

type Dialog = 'none' | 'override' | 'note' | 'help';

export function ReviewPage({ id }: { id: string }) {
  const base = `/api/runs/${encodeURIComponent(id)}`;
  const [filter, setFilter] = useState<ReviewFilter>('flagged');
  const url = `${base}/review?filter=${filter}`;
  const [data, setData] = useState<ReviewResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showLabel, setShowLabel] = useState(false);
  const [dialog, setDialog] = useState<Dialog>('none');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [live, setLive] = useState('');
  const [errors, setErrors] = useState<SaveError[]>([]);
  const [outputs, setOutputs] = useState<{ state: 'idle' | 'busy' | 'done' | 'failed'; text: string }>({ state: 'idle', text: '' });

  // A poll that started before a write finished may carry old data: it is dropped.
  const writes = useRef({ seq: 0, inFlight: 0 });
  const dataRef = useRef<ReviewResponse | null>(null);
  dataRef.current = data;
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const load = useCallback(async () => {
    const seq = writes.current.seq;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(await readError(res));
      const next = (await res.json()) as ReviewResponse;
      if (writes.current.inFlight || seq !== writes.current.seq || next.filter !== filterRef.current) return;
      setData(next);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message || 'Request failed');
    }
  }, [url]);
  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const rows = data && data.filter === filter ? data.rows : [];
  const index = rows.findIndex((r) => r.rowId === selectedId);
  const row = index >= 0 ? rows[index]! : null;

  // Keep a valid selection: the first row still to review, when nothing (or a vanished row) is selected.
  useEffect(() => {
    if (!rows.length) return;
    if (index < 0) setSelectedId(rows[nextUnreviewed(rows, -1)]!.rowId);
  }, [rows, index]);

  useEffect(() => {
    if (index >= 0) document.getElementById(`q-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const replaceRow = (d: ReviewResponse, next: ReviewRow, totals?: Pick<ReviewResponse, 'counts' | 'accuracy'>): ReviewResponse => ({
    ...d,
    ...(totals ?? {}),
    rows: d.rows.map((r) => (r.rowId === next.rowId ? next : r)),
  });

  const decide = useCallback(
    async (body: DecisionBody, o: { advance?: boolean } = {}) => {
      const d = dataRef.current;
      const before = d?.rows.find((r) => r.rowId === body.rowId);
      if (!d || !before) return;
      const optimistic = applyDecision(before, body, new Date().toISOString());
      const totals = adjustTotals(d.counts, d.accuracy, before, optimistic);
      const optimisticData = replaceRow(d, optimistic, totals);
      setData(optimisticData);
      setLive(announce(body, before, totals.counts));
      setErrors((es) => es.filter((e) => e.rowId !== body.rowId));
      if (o.advance && body.action !== 'clear') {
        const i = optimisticData.rows.findIndex((r) => r.rowId === body.rowId);
        const next = nextUnreviewed(optimisticData.rows, i);
        setSelectedId(optimisticData.rows[next]!.rowId);
      }
      if (body.action !== 'clear') setDrafts(({ [body.rowId]: _, ...rest }) => rest);

      writes.current.seq++;
      writes.current.inFlight++;
      try {
        const res = await postJson<OverrideResponse>(`${base}/overrides`, body);
        setData((cur) => (cur ? replaceRow(cur, res.row, { counts: res.counts, accuracy: res.accuracy }) : cur));
      } catch (err) {
        const message = (err as Error).message || 'Request failed';
        // Roll back this row only; other rows may have decisions in flight.
        setData((cur) => {
          if (!cur) return cur;
          const now = cur.rows.find((r) => r.rowId === body.rowId);
          if (!now) return cur;
          return replaceRow(cur, before, adjustTotals(cur.counts, cur.accuracy, now, before));
        });
        if (body.action !== 'clear' && 'note' in body && body.note) setDrafts((ds) => ({ ...ds, [body.rowId]: body.note! }));
        setErrors((es) => [...es.filter((e) => e.rowId !== body.rowId), { rowId: body.rowId, message, body }]);
        setLive(`Not saved: row ${body.rowId}. ${message}`);
      } finally {
        writes.current.inFlight--;
        writes.current.seq++;
      }
    },
    [base],
  );

  const writeOutputs = async () => {
    setOutputs({ state: 'busy', text: 'Writing…' });
    try {
      const res = await postJson<OutputsResponse>(`${base}/outputs`, {});
      const text = `Wrote ${res.written.join(' and ')} at ${formatTime(res.at)}.`;
      setOutputs({ state: 'done', text });
      setLive(text);
    } catch (err) {
      setOutputs({ state: 'failed', text: `Could not write the files: ${(err as Error).message}` });
    }
  };

  const draftNote = row ? drafts[row.rowId] : undefined;

  const accept = useCallback(() => {
    if (!row) return;
    if (!row.acceptable) {
      setLive(`Row ${row.rowId} has no valid answer to accept. Press o to pick one.`);
      return;
    }
    void decide({ rowId: row.rowId, action: 'accept', ...(draftNote ? { note: draftNote } : {}) }, { advance: true });
  }, [row, draftNote, decide]);

  const pick = useCallback(
    (answer: string) => {
      if (!row) return;
      setDialog('none');
      void decide(decisionFor(row, answer, draftNote), { advance: true });
    },
    [row, draftNote, decide],
  );

  const undo = useCallback(() => {
    if (!row) return;
    if (!row.review) {
      setLive(`Row ${row.rowId} has no decision to undo.`);
      return;
    }
    void decide({ rowId: row.rowId, action: 'clear' });
  }, [row, decide]);

  const saveNote = (text: string) => {
    setDialog('none');
    if (!row) return;
    const note = text.trim();
    const r = row.review;
    if (r) {
      // Re-send the current decision with the note: the last line for a row wins.
      const body: DecisionBody =
        r.action === 'accept'
          ? { rowId: row.rowId, action: 'accept', ...(note ? { note } : {}) }
          : { rowId: row.rowId, action: 'override', answer: r.answer, ...(note ? { note } : {}) };
      void decide(body);
      return;
    }
    setDrafts((ds) => {
      const { [row.rowId]: _, ...rest } = ds;
      return note ? { ...rest, [row.rowId]: note } : rest;
    });
    setLive(note ? `Note kept for row ${row.rowId}; it is saved with your decision.` : 'Note removed.');
  };

  // Keyboard shortcuts. Dialogs handle their own keys; nothing fires while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog !== 'none' || e.defaultPrevented) return;
      const action = keyToAction({
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        typing: isTypingTarget(e.target as HTMLElement | null),
      });
      if (!action) return;
      e.preventDefault();
      switch (action.type) {
        case 'next':
        case 'prev': {
          if (!rows.length) return;
          const i = index < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, index + (action.type === 'next' ? 1 : -1)));
          setSelectedId(rows[i]!.rowId);
          return;
        }
        case 'accept':
          return accept();
        case 'override':
          if (row) setDialog('override');
          return;
        case 'pick': {
          const label = row?.triage?.top[action.index]?.label;
          if (row && label && data?.kind === 'closed') pick(label);
          else if (row) setLive(`There is no round-0 choice ${action.index + 1} for this row.`);
          return;
        }
        case 'undo':
          return undo();
        case 'note':
          if (row) setDialog('note');
          return;
        case 'filter':
          return setFilter((f) => nextFilter(f));
        case 'label':
          return setShowLabel((s) => !s);
        case 'help':
          return setDialog('help');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, rows, index, row, data?.kind, accept, pick, undo]);

  if (!data) {
    return (
      <>
        <Crumbs id={id} />
        <h1>Review queue</h1>
        {loadError ? <p className="note note-error">{loadError}</p> : <p className="muted">Loading…</p>}
      </>
    );
  }

  const c = data.counts;
  return (
    <>
      <Crumbs id={id} />
      <div className="review-head">
        <h1>Review queue</h1>
        <button type="button" className="button" onClick={() => setDialog('help')} aria-keyshortcuts="?">
          Shortcuts <kbd>?</kbd>
        </button>
      </div>
      {loadError && (
        <p className="note note-error" role="status">
          Could not refresh: {loadError}. Showing the last data received.
        </p>
      )}
      {data.running && (
        <p className="note note-warn" role="status">
          <span aria-hidden="true">▶ </span>This run is still running, so new rows may still be flagged. Your decisions are kept.
        </p>
      )}

      <section className="card review-summary" aria-label="Review progress">
        <div>
          <ProgressBar value={c.flagged ? c.reviewed / c.flagged : null} label="Flagged rows reviewed" tone={c.flagged && !c.remaining ? 'ok' : 'accent'} />
          <p className="small">
            <strong>
              {formatCount(c.reviewed)} of {formatCount(c.flagged)}
            </strong>{' '}
            flagged rows reviewed · {formatCount(c.remaining)} to review
            {c.reviewedOther > 0 && ` · ${formatCount(c.reviewedOther)} other row${c.reviewedOther === 1 ? '' : 's'} reviewed`}
            {` · ${formatCount(c.overridden)} answer${c.overridden === 1 ? '' : 's'} changed`}
          </p>
        </div>
        {data.accuracy ? (
          <p className="accuracy">
            Accuracy, no human <strong>{formatPct(data.accuracy.noHuman, 1)}</strong> <span aria-hidden="true">→</span> with a human <strong>{formatPct(data.accuracy.withHuman, 1)}</strong>
            <span className="muted small"> (on {formatCount(data.accuracy.of)} labeled rows)</span>
          </p>
        ) : (
          <p className="muted small">No label column, so no accuracy.</p>
        )}
        <div className="outputs">
          <button type="button" className="button" onClick={() => void writeOutputs()} disabled={outputs.state === 'busy'}>
            Write output files
          </button>
          <span className={`small ${outputs.state === 'failed' ? 'error-text' : 'muted'}`} role="status">
            {outputs.text || 'Rewrites enriched.csv and review.csv with your decisions (same as report --write).'}
          </span>
        </div>
      </section>

      <fieldset className="filters">
        <legend className="sr-only">Show</legend>
        {FILTERS.map((f) => (
          <label key={f} className={`filter${f === filter ? ' filter-on' : ''}`}>
            <input type="radio" name="filter" value={f} checked={f === filter} onChange={() => setFilter(f)} />
            {FILTER_TEXT[f]}
            <span className="muted small"> {f === 'flagged' ? formatCount(c.flagged) : f === 'reviewed' ? formatCount(c.reviewed + c.reviewedOther) : formatCount(c.rows)}</span>
          </label>
        ))}
        <span className="muted small">
          <kbd>f</kbd> cycles
        </span>
      </fieldset>

      {errors.length > 0 && (
        <div className="note note-error" role="alert">
          {errors.map((e) => (
            <p key={e.rowId}>
              Not saved: row <code>{e.rowId}</code>. {e.message}{' '}
              <button type="button" className="button" onClick={() => void decide(e.body)}>
                Retry
              </button>{' '}
              <button type="button" className="button" onClick={() => setErrors((es) => es.filter((x) => x.rowId !== e.rowId))}>
                Dismiss
              </button>
            </p>
          ))}
        </div>
      )}

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {live}
      </p>

      {data.filter !== filter ? (
        <p className="muted">Loading…</p>
      ) : !rows.length ? (
        <section className="card empty">
          <h2 className="card-title">{filter === 'reviewed' ? 'No decisions yet' : filter === 'flagged' ? 'Nothing flagged' : 'No rows'}</h2>
          <p className="muted">
            {filter === 'flagged'
              ? data.running
                ? 'Nothing is flagged yet. Rows show up here as the run flags them.'
                : 'The pipeline accepted every row it finished.'
              : filter === 'reviewed'
                ? 'Accept or override a row and it shows up here.'
                : 'This run has no rows.'}
          </p>
        </section>
      ) : (
        <div className="review-layout">
          <Queue rows={rows} index={index} onSelect={setSelectedId} filter={filter} />
          {row && (
            <Detail
              row={row}
              data={data}
              showLabel={showLabel}
              onToggleLabel={() => setShowLabel((s) => !s)}
              draftNote={draftNote}
              onAccept={accept}
              onOverride={() => setDialog('override')}
              onPick={pick}
              onUndo={undo}
              onNote={() => setDialog('note')}
            />
          )}
        </div>
      )}

      {row && (
        <Modal open={dialog === 'override'} onClose={() => setDialog('none')} title={`Answer for row ${row.rowId}`}>
          {data.kind === 'closed' && data.labels ? (
            <LabelPicker labels={data.labels} top={row.triage?.top.map((t) => t.label) ?? []} current={row.answer} onPick={pick} />
          ) : (
            <TextAnswer max={data.maxAnswerChars} initial={row.review?.answer ?? row.answer} onSubmit={pick} />
          )}
        </Modal>
      )}
      {row && (
        <Modal open={dialog === 'note'} onClose={() => setDialog('none')} title={`Note on row ${row.rowId}`}>
          <NoteForm max={data.maxNoteChars} initial={row.review?.note ?? draftNote ?? ''} hasDecision={!!row.review} onSave={saveNote} />
        </Modal>
      )}
      <Modal open={dialog === 'help'} onClose={() => setDialog('none')} title="Keyboard shortcuts">
        <table className="kv shortcuts">
          <caption className="sr-only">Keyboard shortcuts</caption>
          <tbody>
            {SHORTCUTS.map(([k, what]) => (
              <tr key={k}>
                <th scope="row">
                  <kbd>{k}</kbd>
                </th>
                <td>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Shortcuts don’t fire while you type in a field. After a decision, the next row still to review opens.</p>
      </Modal>
    </>
  );
}

function Crumbs({ id }: { id: string }) {
  return (
    <p className="crumbs small">
      <a href="#/">All runs</a> / <a href={runHref(id)}>{id}</a> / Review
    </p>
  );
}

// ---------------------------------------------------------------- the list

function statusText(r: ReviewRow): { icon: string; text: string } {
  const was = r.review && r.pipelineStatus !== 'flagged' ? ` (pipeline: ${r.pipelineStatus})` : '';
  if (r.review?.action === 'accept') return { icon: '✓', text: `Accepted${was}` };
  if (r.review) return { icon: '✎', text: `Changed${was}` };
  if (r.pipelineStatus === 'flagged') return { icon: '•', text: 'To review' };
  if (r.pipelineStatus === 'accepted') return { icon: '·', text: 'Accepted by the pipeline' };
  return { icon: '…', text: 'Pending' };
}

function Queue({ rows, index, onSelect, filter }: { rows: ReviewRow[]; index: number; onSelect: (id: string) => void; filter: ReviewFilter }) {
  return (
    <section className="card queue" aria-labelledby="queue-h">
      <h2 id="queue-h" className="card-title">
        {FILTER_TEXT[filter]} <span className="muted small">({formatCount(rows.length)})</span>
      </h2>
      <ol className="queue-list">
        {rows.map((r, i) => {
          const s = statusText(r);
          const preview = Object.values(r.input).join(' · ');
          return (
            <li key={r.rowId}>
              <button
                type="button"
                id={`q-${i}`}
                className={`queue-item${i === index ? ' queue-current' : ''}${r.review ? ' queue-done' : ''}`}
                aria-current={i === index ? 'true' : undefined}
                onClick={() => onSelect(r.rowId)}
              >
                <span className="queue-id">{r.rowId}</span>
                <span className="queue-preview">{preview.length > 70 ? `${preview.slice(0, 70)}…` : preview}</span>
                <span className="queue-status small">
                  <span aria-hidden="true">{s.icon} </span>
                  {s.text}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------- the current row

const p2 = (x: number | null | undefined) => (x === null || x === undefined ? '—' : x.toFixed(2));

function Detail(props: {
  row: ReviewRow;
  data: ReviewResponse;
  showLabel: boolean;
  onToggleLabel: () => void;
  draftNote: string | undefined;
  onAccept: () => void;
  onOverride: () => void;
  onPick: (label: string) => void;
  onUndo: () => void;
  onNote: () => void;
}) {
  const { row, data, showLabel } = props;
  const r = row.review;
  const s = statusText(row);
  const lastVerify = [...row.rounds].reverse().find((x) => x.verify)?.verify;
  return (
    <section className="card detail" aria-labelledby="detail-h">
      <div className="detail-head">
        <h2 id="detail-h" className="card-title">
          Row <code>{row.rowId}</code>
        </h2>
        <span className="tag">
          <span aria-hidden="true">{s.icon} </span>
          {s.text}
        </span>
      </div>

      <dl className="input-fields">
        {Object.entries(row.input).map(([col, value]) => (
          <div key={col}>
            <dt>{col}</dt>
            <dd className="input-text">{value || <span className="muted">(empty)</span>}</dd>
          </div>
        ))}
      </dl>

      <div className="answer-box">
        <p className="answer-line">
          <span className="muted">Pipeline’s answer</span> <strong className="answer">{row.answer || '(none)'}</strong>
          {row.answer && !row.acceptable && <span className="error-text small"> · not a valid answer, so it can’t be accepted</span>}
        </p>
        <p className="muted small">
          {row.round === 0 ? 'round 0 (triage)' : `round ${row.round}`}
          {row.model && ` · ${shortModel(row.model)}`}
          {row.verdict && ` · ${row.verdict.replace(/_/g, ' ')}`}
          {lastVerify && ` · p(supported) ${p2(lastVerify.probabilities.supported)}`}
        </p>
        {r ? (
          <p className="decision">
            <span aria-hidden="true">{r.action === 'accept' ? '✓ ' : '✎ '}</span>
            Your decision: {r.action === 'accept' ? 'accepted' : <>changed to <strong>{r.answer}</strong></>}
            <span className="muted small"> · {formatTime(r.at)}</span>
            {r.note && <span className="note-text"> · “{r.note}”</span>}
            {r.stale && (
              <span className="error-text small">
                {' '}
                · the pipeline’s answer changed since (was {r.previous || 'none'})
              </span>
            )}
          </p>
        ) : (
          <p className="muted">No decision yet.</p>
        )}
        {props.draftNote && !r && <p className="small">Note to save with your decision: “{props.draftNote}”</p>}
        <div className="actions">
          <button type="button" className="button button-primary" onClick={props.onAccept} aria-keyshortcuts="a" disabled={!row.acceptable}>
            Accept <kbd>a</kbd>
          </button>
          <button type="button" className="button" onClick={props.onOverride} aria-keyshortcuts="o">
            Override… <kbd>o</kbd>
          </button>
          <button type="button" className="button" onClick={props.onUndo} aria-keyshortcuts="u" disabled={!r}>
            Undo <kbd>u</kbd>
          </button>
          <button type="button" className="button" onClick={props.onNote} aria-keyshortcuts="n">
            Note… <kbd>n</kbd>
          </button>
        </div>
      </div>

      {data.labelColumn && (
        <div className="expected">
          <button type="button" className="button" aria-pressed={showLabel} onClick={props.onToggleLabel} aria-keyshortcuts="l">
            {showLabel ? 'Hide' : 'Show'} label <kbd>l</kbd>
          </button>
          {showLabel ? (
            <span>
              {' '}
              Expected (<code>{data.labelColumn}</code>): <strong>{row.expected || '(empty)'}</strong>{' '}
              {row.expected &&
                (row.expected.trim().toLowerCase() === row.finalAnswer.trim().toLowerCase() ? (
                  <span className="ok-text">✓ matches the final answer</span>
                ) : (
                  <span className="error-text">✗ differs from the final answer</span>
                ))}
            </span>
          ) : (
            <span className="muted small"> Hidden so it doesn’t bias you.</span>
          )}
        </div>
      )}

      {row.triage && (
        <section aria-labelledby="top3-h">
          <h3 id="top3-h">Round 0: the decision model’s top 3</h3>
          {row.triage.top.length ? (
            <ol className="top3">
              {row.triage.top.map((t, i) => (
                <li key={t.label}>
                  {data.kind === 'closed' ? (
                    <button type="button" className="top3-pick" onClick={() => props.onPick(t.label)} aria-keyshortcuts={String(i + 1)}>
                      <kbd>{i + 1}</kbd> <span className="top3-label">{t.label}</span>
                    </button>
                  ) : (
                    <span className="top3-label">{t.label}</span>
                  )}
                  <span className="top3-bar" aria-hidden="true">
                    <span style={{ width: `${Math.round(t.probability * 100)}%` }} />
                  </span>
                  <span className="num">{t.probability.toFixed(2)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">No label had any probability.</p>
          )}
          <p className="muted small">
            cannot tell {row.triage.cannotTell.toFixed(2)} · {shortModel(row.triage.model)} · {formatUsd(row.triage.costUsd)}
          </p>
        </section>
      )}

      <section aria-labelledby="rounds-h">
        <h3 id="rounds-h">Rounds</h3>
        {!row.rounds.length ? (
          <p className="muted small">{row.round === 0 && row.pipelineStatus === 'accepted' ? 'Accepted in triage; no writer was called.' : 'No writer answer yet.'}</p>
        ) : (
          <div className="table-wrap">
            <table className="data rounds">
              <thead>
                <tr>
                  <th scope="col">Round</th>
                  <th scope="col">Model</th>
                  <th scope="col">Answer</th>
                  <th scope="col">Verdict</th>
                  <th scope="col" className="num">
                    p(supported)
                  </th>
                  <th scope="col" className="num">
                    p(unsupported)
                  </th>
                  <th scope="col" className="num">
                    p(cannot tell)
                  </th>
                  <th scope="col" className="num">
                    Cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {row.rounds.map((x) => (
                  <tr key={x.round}>
                    <td>{x.round}</td>
                    <td title={x.model}>{shortModel(x.model)}</td>
                    <td className="answer-cell">
                      {x.inFlight ? (
                        <span className="muted">in flight</span>
                      ) : (
                        <>
                          {x.answer || <span className="muted">(none)</span>}
                          {!x.valid && <div className="error-text small">{x.error ?? 'not a valid answer'}</div>}
                        </>
                      )}
                    </td>
                    <td>{x.verify ? x.verify.verdict.replace(/_/g, ' ') : <span className="muted">—</span>}</td>
                    <td className="num">{p2(x.verify?.probabilities.supported)}</td>
                    <td className="num">{p2(x.verify?.probabilities.unsupported)}</td>
                    <td className="num">{p2(x.verify?.probabilities.cannot_tell)}</td>
                    <td className="num">{formatUsd(x.costUsd + (x.verify?.costUsd ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}

// ---------------------------------------------------------------- dialogs

function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
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

function LabelPicker({ labels, top, current, onPick }: { labels: string[]; top: string[]; current: string; onPick: (label: string) => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const options = useMemo(() => filterLabels(labels, query, top), [labels, query, top]);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`#opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const label = options[active];
      if (label) onPick(label);
    }
  };
  return (
    <div className="picker">
      <label htmlFor="picker-input" className="small">
        Type to filter {labels.length} labels; ↑ ↓ to move, Enter to choose
      </label>
      <input
        id="picker-input"
        className="text-input"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded="true"
        aria-controls="picker-list"
        aria-autocomplete="list"
        aria-activedescendant={options.length ? `opt-${active}` : undefined}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <ul id="picker-list" role="listbox" aria-label="Labels" className="picker-list" ref={listRef}>
        {options.map((l, i) => (
          <li
            key={l}
            id={`opt-${i}`}
            role="option"
            aria-selected={i === active}
            className={`picker-option${i === active ? ' picker-active' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(l)}
          >
            {l}
            {l === current && <span className="muted small"> · pipeline’s answer</span>}
            {!query && top.includes(l) && <span className="muted small"> · round-0 top {top.indexOf(l) + 1}</span>}
          </li>
        ))}
        {!options.length && <li className="muted">No label matches “{query}”.</li>}
      </ul>
      <p className="sr-only" aria-live="polite">
        {options.length} label{options.length === 1 ? '' : 's'} match.
      </p>
    </div>
  );
}

function TextAnswer({ max, initial, onSubmit }: { max: number; initial: string; onSubmit: (answer: string) => void }) {
  const [text, setText] = useState(initial);
  const submit = () => {
    if (text.trim()) onSubmit(text.trim());
  };
  return (
    <form
      className="picker"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label htmlFor="answer-input" className="small">
        Your answer (Enter saves, Shift+Enter for a new line)
      </label>
      <textarea
        id="answer-input"
        className="text-input"
        autoFocus
        rows={6}
        maxLength={max}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button type="submit" className="button button-primary" disabled={!text.trim()}>
        Save answer
      </button>
    </form>
  );
}

function NoteForm({ max, initial, hasDecision, onSave }: { max: number; initial: string; hasDecision: boolean; onSave: (note: string) => void }) {
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
