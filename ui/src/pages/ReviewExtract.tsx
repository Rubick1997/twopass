import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ExtractOverrideResponse,
  ExtractReviewResponse,
  FieldDecisionBody,
  FieldItem,
  FieldRoundInfo,
  OutputsResponse,
  ReviewFilter,
} from '../../../src/ui/api-types.ts';
import { shortModel } from '../../../src/ui/models.ts';
import { ProgressBar } from '../components.tsx';
import { formatCount, formatPct, formatTime } from '../format.ts';
import { FILTERS, nextFilter } from '../review.ts';
import {
  adjustExtractCounts,
  announceField,
  applyFieldDecision,
  decisionForItem,
  EXTRACT_SHORTCUTS,
  FIELD_FILTER_TEXT,
  highlightSegments,
  isTypingTarget,
  itemKey,
  keyToExtractAction,
  nextUnreviewedItem,
  normaliseSelection,
} from '../review-extract.ts';
import { Crumbs, Modal, NoteForm, postJson, readError } from './review-parts.tsx';

// The review page for extraction runs: one flagged field at a time, with the document text and the values the
// pipeline proposed highlighted in it. Same shape as the classify page: decisions show at once and roll back with a
// visible error if the POST fails; the keyboard does everything.

const REFRESH_MS = 5000;
const p2 = (x: number | null | undefined) => (x === null || x === undefined ? '—' : x.toFixed(2));
const NOT_IN_DOC = 'not in this document';

interface SaveError {
  key: string;
  label: string;
  message: string;
  body: FieldDecisionBody;
}

type Dialog = 'none' | 'override' | 'note' | 'help';

function statusText(i: FieldItem): { icon: string; text: string } {
  const was = i.review && i.pipelineStatus !== 'flagged' ? ` (pipeline: ${i.pipelineStatus})` : '';
  if (i.review?.action === 'accept') return { icon: '✓', text: `Accepted${was}` };
  if (i.review) return { icon: '✎', text: `Changed${was}` };
  if (i.pipelineStatus === 'flagged') return { icon: '•', text: 'To review' };
  if (i.pipelineStatus === 'accepted') return { icon: '·', text: 'Accepted by the pipeline' };
  return { icon: '…', text: 'Pending' };
}

const showValue = (v: string | null) => (v === null ? <em className="muted">{NOT_IN_DOC}</em> : <span className="field-value">{v || '(empty)'}</span>);

export function ReviewExtract({ id }: { id: string }) {
  const base = `/api/runs/${encodeURIComponent(id)}`;
  const [filter, setFilter] = useState<ReviewFilter>('flagged');
  const url = `${base}/review?filter=${filter}`;
  const [data, setData] = useState<ExtractReviewResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showLabel, setShowLabel] = useState(false);
  const [dialog, setDialog] = useState<Dialog>('none');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [live, setLive] = useState('');
  const [errors, setErrors] = useState<SaveError[]>([]);
  const [outputs, setOutputs] = useState<{ state: 'idle' | 'busy' | 'done' | 'failed'; text: string }>({ state: 'idle', text: '' });
  const docBox = useRef<HTMLDivElement>(null);

  const writes = useRef({ seq: 0, inFlight: 0 });
  const dataRef = useRef<ExtractReviewResponse | null>(null);
  dataRef.current = data;
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const load = useCallback(async () => {
    const seq = writes.current.seq;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(await readError(res));
      const next = (await res.json()) as ExtractReviewResponse;
      if (writes.current.inFlight || seq !== writes.current.seq || next.filter !== filterRef.current) return;
      setData(next);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message || 'Request failed');
    }
  }, [url]);
  // The documents make this response large: it is fetched again only while the run is still running.
  const running = data?.running ?? false;
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [running, load]);

  const items = data && data.filter === filter ? data.items : [];
  const index = items.findIndex((i) => itemKey(i) === selectedKey);
  const item = index >= 0 ? items[index]! : null;

  useEffect(() => {
    if (!items.length) return;
    if (index < 0) setSelectedKey(itemKey(items[nextUnreviewedItem(items, -1)]!));
  }, [items, index]);
  useEffect(() => {
    if (index >= 0) document.getElementById(`q-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  // The first highlight scrolls into view inside the document box (the page itself does not move).
  useEffect(() => {
    const box = docBox.current;
    if (!box) return;
    const mark = box.querySelector<HTMLElement>('mark');
    box.scrollTop = mark ? Math.max(0, mark.offsetTop - 48) : 0;
  }, [selectedKey, data?.documents]);

  const replaceItem = (d: ExtractReviewResponse, next: FieldItem, counts?: ExtractReviewResponse['counts'], accuracy?: ExtractReviewResponse['accuracy']): ExtractReviewResponse => ({
    ...d,
    ...(counts ? { counts } : {}),
    ...(accuracy !== undefined ? { accuracy } : {}),
    items: d.items.map((i) => (itemKey(i) === itemKey(next) ? next : i)),
  });

  const decide = useCallback(
    async (body: FieldDecisionBody, o: { advance?: boolean } = {}) => {
      const d = dataRef.current;
      const key = itemKey({ docId: body.rowId, field: body.field });
      const before = d?.items.find((i) => itemKey(i) === key);
      if (!d || !before) return;
      const optimistic = applyFieldDecision(before, body, new Date().toISOString());
      const counts = adjustExtractCounts(d.counts, before, optimistic);
      const optimisticData = replaceItem(d, optimistic, counts);
      setData(optimisticData);
      setLive(announceField(body, before, counts));
      setErrors((es) => es.filter((e) => e.key !== key));
      if (o.advance && body.action !== 'clear') {
        const next = nextUnreviewedItem(optimisticData.items, optimisticData.items.findIndex((i) => itemKey(i) === key));
        setSelectedKey(itemKey(optimisticData.items[next]!));
      }
      if (body.action !== 'clear') setDrafts(({ [key]: _, ...rest }) => rest);

      writes.current.seq++;
      writes.current.inFlight++;
      try {
        const res = await postJson<ExtractOverrideResponse>(`${base}/overrides`, body);
        setData((cur) => (cur ? replaceItem(cur, res.item, res.counts, res.accuracy) : cur));
      } catch (err) {
        const message = (err as Error).message || 'Request failed';
        setData((cur) => {
          if (!cur) return cur;
          const now = cur.items.find((i) => itemKey(i) === key);
          if (!now) return cur;
          return replaceItem(cur, before, adjustExtractCounts(cur.counts, now, before));
        });
        if (body.action !== 'clear' && body.note) setDrafts((ds) => ({ ...ds, [key]: body.note! }));
        setErrors((es) => [...es.filter((e) => e.key !== key), { key, label: `${before.docId} · ${before.field}`, message, body }]);
        setLive(`Not saved: ${before.field} of ${before.docId}. ${message}`);
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
      setOutputs({ state: 'failed', text: `Could not write the file: ${(err as Error).message}` });
    }
  };

  const key = item ? itemKey(item) : '';
  const draftNote = item ? drafts[key] : undefined;

  const accept = useCallback(() => {
    if (!item) return;
    if (!item.acceptable) {
      setLive(`This field has no usable value to accept. Press o to type one.`);
      return;
    }
    void decide({ rowId: item.docId, field: item.field, action: 'accept', ...(draftNote ? { note: draftNote } : {}) }, { advance: true });
  }, [item, draftNote, decide]);

  const choose = useCallback(
    (value: string | null) => {
      if (!item) return;
      setDialog('none');
      void decide(decisionForItem(item, value, draftNote), { advance: true });
    },
    [item, draftNote, decide],
  );

  const useSelection = useCallback(() => {
    const sel = window.getSelection();
    const text = sel && docBox.current?.contains(sel.anchorNode) ? normaliseSelection(sel.toString()) : '';
    if (!text) {
      setLive('Select the right value in the document text first, then press s.');
      return;
    }
    choose(text.length > (data?.maxAnswerChars ?? 2000) ? text.slice(0, data?.maxAnswerChars ?? 2000) : text);
  }, [choose, data?.maxAnswerChars]);

  const undo = useCallback(() => {
    if (!item) return;
    if (!item.review) {
      setLive('This field has no decision to undo.');
      return;
    }
    void decide({ rowId: item.docId, field: item.field, action: 'clear' });
  }, [item, decide]);

  const saveNote = (text: string) => {
    setDialog('none');
    if (!item) return;
    const note = text.trim();
    const r = item.review;
    const base = { rowId: item.docId, field: item.field };
    if (r) {
      const body: FieldDecisionBody =
        r.action === 'accept' ? { ...base, action: 'accept', ...(note ? { note } : {}) } : { ...base, action: 'override', answer: r.value, ...(note ? { note } : {}) };
      void decide(body);
      return;
    }
    setDrafts((ds) => {
      const { [key]: _, ...rest } = ds;
      return note ? { ...rest, [key]: note } : rest;
    });
    setLive(note ? 'Note kept; it is saved with your decision.' : 'Note removed.');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog !== 'none' || e.defaultPrevented) return;
      const action = keyToExtractAction({
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
          if (!items.length) return;
          const i = index < 0 ? 0 : Math.min(items.length - 1, Math.max(0, index + (action.type === 'next' ? 1 : -1)));
          setSelectedKey(itemKey(items[i]!));
          return;
        }
        case 'accept':
          return accept();
        case 'override':
          if (item) setDialog('override');
          return;
        case 'absent':
          return choose(null);
        case 'selection':
          return useSelection();
        case 'undo':
          return undo();
        case 'note':
          if (item) setDialog('note');
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
  }, [dialog, items, index, item, accept, choose, useSelection, undo]);

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
        <h1>Review queue: fields</h1>
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
          <span aria-hidden="true">▶ </span>This run is still running, so new fields may still be flagged. Your decisions are kept.
        </p>
      )}

      <section className="card review-summary" aria-label="Review progress">
        <div>
          <ProgressBar value={c.flagged ? c.reviewed / c.flagged : null} label="Flagged fields reviewed" tone={c.flagged && !c.remaining ? 'ok' : 'accent'} />
          <p className="small">
            <strong>
              {formatCount(c.reviewed)} of {formatCount(c.flagged)}
            </strong>{' '}
            flagged fields reviewed · {formatCount(c.remaining)} to review
            {c.reviewedOther > 0 && ` · ${formatCount(c.reviewedOther)} other field${c.reviewedOther === 1 ? '' : 's'} reviewed`}
            {` · ${formatCount(c.overridden)} value${c.overridden === 1 ? '' : 's'} changed`}
          </p>
        </div>
        {data.accuracy ? (
          <p className="accuracy">
            Field accuracy, no human <strong>{formatPct(data.accuracy.noHuman, 1)}</strong> <span aria-hidden="true">→</span> with a human{' '}
            <strong>{formatPct(data.accuracy.withHuman, 1)}</strong>
            <span className="muted small"> (on {formatCount(data.accuracy.of)} labeled fields)</span>
          </p>
        ) : (
          <p className="muted small">No label column, so no accuracy.</p>
        )}
        <div className="outputs">
          <button type="button" className="button" onClick={() => void writeOutputs()} disabled={outputs.state === 'busy'}>
            Write output files
          </button>
          <span className={`small ${outputs.state === 'failed' ? 'error-text' : 'muted'}`} role="status">
            {outputs.text || 'Rewrites enriched-fields.csv with your decisions (same as report --write).'}
          </span>
        </div>
      </section>

      <fieldset className="filters">
        <legend className="sr-only">Show</legend>
        {FILTERS.map((f) => (
          <label key={f} className={`filter${f === filter ? ' filter-on' : ''}`}>
            <input type="radio" name="filter" value={f} checked={f === filter} onChange={() => setFilter(f)} />
            {FIELD_FILTER_TEXT[f]}
            <span className="muted small"> {f === 'flagged' ? formatCount(c.flagged) : f === 'reviewed' ? formatCount(c.reviewed + c.reviewedOther) : formatCount(c.fields)}</span>
          </label>
        ))}
        <span className="muted small">
          <kbd>f</kbd> cycles
        </span>
      </fieldset>

      {errors.length > 0 && (
        <div className="note note-error" role="alert">
          {errors.map((e) => (
            <p key={e.key}>
              Not saved: <code>{e.label}</code>. {e.message}{' '}
              <button type="button" className="button" onClick={() => void decide(e.body)}>
                Retry
              </button>{' '}
              <button type="button" className="button" onClick={() => setErrors((es) => es.filter((x) => x.key !== e.key))}>
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
      ) : !items.length ? (
        <section className="card empty">
          <h2 className="card-title">{filter === 'reviewed' ? 'No decisions yet' : filter === 'flagged' ? 'Nothing flagged' : 'No fields'}</h2>
          <p className="muted">
            {filter === 'flagged'
              ? data.running
                ? 'Nothing is flagged yet. Fields show up here as the run flags them.'
                : 'The pipeline accepted every field it finished.'
              : filter === 'reviewed'
                ? 'Accept or override a field and it shows up here.'
                : 'This run has no fields.'}
          </p>
        </section>
      ) : (
        <div className="review-layout">
          <section className="card queue" aria-labelledby="queue-h">
            <h2 id="queue-h" className="card-title">
              {FIELD_FILTER_TEXT[filter]} <span className="muted small">({formatCount(items.length)})</span>
            </h2>
            <ol className="queue-list">
              {items.map((i, n) => {
                const s = statusText(i);
                return (
                  <li key={itemKey(i)}>
                    <button
                      type="button"
                      id={`q-${n}`}
                      className={`queue-item${n === index ? ' queue-current' : ''}${i.review ? ' queue-done' : ''}`}
                      aria-current={n === index ? 'true' : undefined}
                      onClick={() => setSelectedKey(itemKey(i))}
                    >
                      <span className="queue-id">
                        {i.docId} · {i.field} · round {i.round}
                      </span>
                      <span className="queue-preview">{i.value === null ? NOT_IN_DOC : i.value.length > 70 ? `${i.value.slice(0, 70)}…` : i.value}</span>
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
          {item && (
            <Detail
              item={item}
              text={data.documents[item.docId] ?? ''}
              labelColumn={data.labelColumn}
              showLabel={showLabel}
              onToggleLabel={() => setShowLabel((s) => !s)}
              draftNote={draftNote}
              docBox={docBox}
              onAccept={accept}
              onOverride={() => setDialog('override')}
              onAbsent={() => choose(null)}
              onSelection={useSelection}
              onUndo={undo}
              onNote={() => setDialog('note')}
            />
          )}
        </div>
      )}

      {item && (
        <Modal open={dialog === 'override'} onClose={() => setDialog('none')} title={`Value for ${item.field} of ${item.docId}`}>
          <ValueForm max={data.maxAnswerChars} initial={item.review?.value ?? item.value ?? ''} onSubmit={choose} />
        </Modal>
      )}
      {item && (
        <Modal open={dialog === 'note'} onClose={() => setDialog('none')} title={`Note on ${item.field} of ${item.docId}`}>
          <NoteForm max={data.maxNoteChars} initial={item.review?.note ?? draftNote ?? ''} hasDecision={!!item.review} onSave={saveNote} />
        </Modal>
      )}
      <Modal open={dialog === 'help'} onClose={() => setDialog('none')} title="Keyboard shortcuts">
        <table className="kv shortcuts">
          <caption className="sr-only">Keyboard shortcuts</caption>
          <tbody>
            {EXTRACT_SHORTCUTS.map(([k, what]) => (
              <tr key={k}>
                <th scope="row">
                  <kbd>{k}</kbd>
                </th>
                <td>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Shortcuts don’t fire while you type in a field. After a decision, the next field still to review opens.</p>
      </Modal>
    </>
  );
}

function RoundRow({ r }: { r: FieldRoundInfo }) {
  return (
    <tr>
      <td>
        <span className={`hl-key hl-key-r${r.round}`} aria-hidden="true" /> {r.round}
      </td>
      <td title={r.model}>{r.model ? shortModel(r.model) : '—'}</td>
      <td className="answer-cell">{showValue(r.value)}</td>
      <td>{r.verdict.replace(/_/g, ' ')}</td>
      <td className="num">{p2(r.probabilities?.supported)}</td>
      <td className="num">{p2(r.probabilities?.unsupported)}</td>
      <td className="num">{p2(r.probabilities?.cannot_tell)}</td>
      <td className="num">{r.spans.length || '—'}</td>
    </tr>
  );
}

function Detail(props: {
  item: FieldItem;
  text: string;
  labelColumn: string | null;
  showLabel: boolean;
  onToggleLabel: () => void;
  draftNote: string | undefined;
  docBox: React.RefObject<HTMLDivElement | null>;
  onAccept: () => void;
  onOverride: () => void;
  onAbsent: () => void;
  onSelection: () => void;
  onUndo: () => void;
  onNote: () => void;
}) {
  const { item, showLabel } = props;
  const r = item.review;
  const s = statusText(item);
  const segments = useMemo(
    () => highlightSegments(props.text, item.round1?.spans ?? [], item.round2?.spans ?? []),
    [props.text, item.round1, item.round2],
  );
  const rounds = [item.round1, item.round2].filter((x): x is FieldRoundInfo => !!x);
  return (
    <section className="card detail" aria-labelledby="detail-h">
      <div className="detail-head">
        <h2 id="detail-h" className="card-title">
          <code>{item.field}</code> <span className="muted small">in</span> <code>{item.docId}</code>
        </h2>
        <span className="tag">
          <span aria-hidden="true">{s.icon} </span>
          {s.text}
        </span>
      </div>

      <div className="answer-box">
        <p className="answer-line">
          <span className="muted">Pipeline’s value</span> <strong className="answer">{item.value === null ? NOT_IN_DOC : item.value || '(empty)'}</strong>
          {!item.acceptable && <span className="error-text small"> · no usable value, so it can’t be accepted</span>}
        </p>
        <p className="muted small">
          round {item.round}
          {item.verdict && ` · ${item.verdict.replace(/_/g, ' ')}`}
        </p>
        {r ? (
          <p className="decision">
            <span aria-hidden="true">{r.action === 'accept' ? '✓ ' : '✎ '}</span>
            Your decision: {r.action === 'accept' ? 'accepted' : <>changed to {r.value === null ? <em>{NOT_IN_DOC}</em> : <strong>{r.value}</strong>}</>}
            <span className="muted small"> · {formatTime(r.at)}</span>
            {r.note && <span className="note-text"> · “{r.note}”</span>}
            {r.stale && <span className="error-text small"> · the pipeline’s value changed since (was {r.previous ?? NOT_IN_DOC})</span>}
          </p>
        ) : (
          <p className="muted">No decision yet.</p>
        )}
        {props.draftNote && !r && <p className="small">Note to save with your decision: “{props.draftNote}”</p>}
        <div className="actions">
          <button type="button" className="button button-primary" onClick={props.onAccept} aria-keyshortcuts="a" disabled={!item.acceptable}>
            Accept <kbd>a</kbd>
          </button>
          <button type="button" className="button" onClick={props.onOverride} aria-keyshortcuts="o">
            Override… <kbd>o</kbd>
          </button>
          <button type="button" className="button" onClick={props.onAbsent} aria-keyshortcuts="x">
            Not in document <kbd>x</kbd>
          </button>
          <button type="button" className="button" onClick={props.onSelection} aria-keyshortcuts="s">
            Use selection <kbd>s</kbd>
          </button>
          <button type="button" className="button" onClick={props.onUndo} aria-keyshortcuts="u" disabled={!r}>
            Undo <kbd>u</kbd>
          </button>
          <button type="button" className="button" onClick={props.onNote} aria-keyshortcuts="n">
            Note… <kbd>n</kbd>
          </button>
        </div>
      </div>

      {props.labelColumn && item.expected !== null && (
        <div className="expected">
          <button type="button" className="button" aria-pressed={showLabel} onClick={props.onToggleLabel} aria-keyshortcuts="l">
            {showLabel ? 'Hide' : 'Show'} label <kbd>l</kbd>
          </button>
          {showLabel ? (
            <span>
              {' '}
              Gold (<code>{props.labelColumn}</code>):{' '}
              {item.expected.length ? <strong>{item.expected.join(' | ')}</strong> : <strong>{NOT_IN_DOC}</strong>}{' '}
              {item.finalCorrect !== null &&
                (item.finalCorrect ? <span className="ok-text">✓ the final value matches</span> : <span className="error-text">✗ the final value differs</span>)}
            </span>
          ) : (
            <span className="muted small"> Hidden so it doesn’t bias you.</span>
          )}
        </div>
      )}

      <section aria-labelledby="values-h">
        <h3 id="values-h">Values by round</h3>
        {!rounds.length ? (
          <p className="muted small">No writer value yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data rounds">
              <thead>
                <tr>
                  <th scope="col">Round</th>
                  <th scope="col">Model</th>
                  <th scope="col">Value</th>
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
                    Found
                  </th>
                </tr>
              </thead>
              <tbody>
                {rounds.map((x) => (
                  <RoundRow key={x.round} r={x} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="doc-h">
        <h3 id="doc-h">Document text</h3>
        <ul className="legend hl-legend">
          <li>
            <mark className="hl hl-r1">round 1</mark> value
          </li>
          <li>
            <mark className="hl hl-r2">round 2</mark> value
          </li>
          <li>
            <mark className="hl hl-both">both</mark> rounds agree
          </li>
        </ul>
        <div className="doc-text" ref={props.docBox} tabIndex={0} role="region" aria-label={`Text of document ${item.docId}`}>
          {segments.map((g, i) =>
            g.kind === 'plain' ? (
              <span key={i}>{g.text}</span>
            ) : (
              <mark key={i} className={`hl hl-${g.kind}`}>
                {g.text}
              </mark>
            ),
          )}
        </div>
        <p className="muted small">
          Values are found by case-insensitive match, any run of whitespace counting as one; up to 20 places per value. A value that is not found is not highlighted.
        </p>
      </section>
    </section>
  );
}

function ValueForm({ max, initial, onSubmit }: { max: number; initial: string; onSubmit: (value: string) => void }) {
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
      <label htmlFor="value-input" className="small">
        The right value (Enter saves). For a field the document does not state, close this and press x.
      </label>
      <input id="value-input" className="text-input" autoFocus autoComplete="off" spellCheck={false} maxLength={max} value={text} onChange={(e) => setText(e.target.value)} />
      <button type="submit" className="button button-primary" disabled={!text.trim()}>
        Save value
      </button>
    </form>
  );
}
