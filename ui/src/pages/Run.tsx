import type { BalanceResponse, BatchRow, RunDetail, StageProgress, StageSpend } from '../../../src/ui/api-types.ts';
import { shortModel } from '../../../src/ui/models.ts';
import { Card, CopyButton, ErrorNote, ModeTag, ProgressBar, SpendVsCap, StatusBadge } from '../components.tsx';
import {
  formatAgo,
  formatCount,
  formatDateTime,
  formatDuration,
  formatEta,
  formatPct,
  formatTime,
  formatUsd,
  share,
  thresholdText,
} from '../format.ts';
import { benchHref, reviewHref, usePoll, useNow } from '../hooks.ts';

export function RunPage({ id }: { id: string }) {
  const run = usePoll<RunDetail>(`/api/runs/${encodeURIComponent(id)}`);
  const balance = usePoll<BalanceResponse>('/api/balance');
  const now = useNow(1000);
  const r = run.data;

  if (!r) {
    return (
      <>
        <h1 className="mono-title">{id}</h1>
        {run.error ? <p className="note note-error">{run.error}</p> : <p className="muted">Loading…</p>}
      </>
    );
  }

  return (
    <>
      <Header r={r} />
      <ErrorNote error={run.error} />
      <Stages stages={r.stages} active={r.activeStage} status={r.status} />
      <div className="grid">
        <SpendCard r={r} />
        <OutcomesCard r={r} />
        <FinishCard r={r} now={now} />
        <BalanceCard balance={balance.data} runReserve={r.reserveUsd} status={r.status} />
      </div>
      <Batches batches={r.batches} now={now} />
      <Recent r={r} now={now} />
    </>
  );
}

function Header({ r }: { r: RunDetail }) {
  const m = r.manifest;
  const t = m.thresholds;
  return (
    <header className="run-head">
      <p className="crumbs small">
        <a href="#/">All runs</a>
        {r.bench && (
          <>
            {' / '}
            <a href={benchHref(r.bench.benchId)}>{r.bench.benchId}</a> ({r.bench.config})
          </>
        )}
      </p>
      <h1 className="mono-title">{r.runId}</h1>
      <div className="head-line">
        <StatusBadge status={r.status} activity={r.activity} />
        <ModeTag mode={r.mode} />
        <span>{formatCount(r.rowCount)} rows</span>
        <span className="muted">started {formatDateTime(r.createdAt)}</span>
        {r.lock?.live && <span className="muted small">pid {r.lock.pid}, heartbeat {formatTime(r.lock.heartbeatAt)}</span>}
      </div>
      {r.problem && <p className="note note-error">{r.problem}</p>}
      {r.review && r.review.flagged > 0 && (
        <p className="review-cta">
          <a className="button button-primary" href={reviewHref(r.runId)}>
            {r.review.remaining
              ? `Review ${formatCount(r.review.remaining)} flagged row${r.review.remaining === 1 ? '' : 's'}`
              : `All ${formatCount(r.review.flagged)} flagged rows reviewed · open the review queue`}
          </a>
          {r.review.reviewed > 0 && r.review.remaining > 0 && (
            <span className="muted small"> {formatCount(r.review.reviewed)} already reviewed</span>
          )}
        </p>
      )}
      {r.resumeCommand && (
        <div className="resume">
          <span>Stopped with {formatCount(r.outcomes?.pending ?? 0)} rows pending. Continue with:</span>
          <code className="cmd">{r.resumeCommand}</code>
          <CopyButton text={r.resumeCommand} label="Copy command" />
        </div>
      )}
      <dl className="facts">
        <div>
          <dt>Writer</dt>
          <dd title={r.models.writer}>{r.models.writer}</dd>
        </div>
        {r.mode !== 'baseline' && (
          <>
            <div>
              <dt>Escalation</dt>
              <dd>{r.models.escalation}</dd>
            </div>
            <div>
              <dt>Triage / verify</dt>
              <dd>
                {r.models.triage === r.models.verify ? r.models.triage : `${r.models.triage} / ${r.models.verify}`}
              </dd>
            </div>
            <div>
              <dt>Thresholds t0 / t1 / t2</dt>
              <dd>
                {thresholdText(t.t0)} / {thresholdText(t.t1)} / {thresholdText(t.t2)}
                <span className="muted small"> from {m.thresholdsSource}</span>
              </dd>
            </div>
          </>
        )}
        <div>
          <dt>Cost cap</dt>
          <dd>{r.maxUsd !== null ? `${formatUsd(r.maxUsd)}${r.capScope === 'bench' ? ' (shared by the bench)' : ''}` : 'none recorded'}</dd>
        </div>
        <div>
          <dt>Input check</dt>
          <dd>
            {r.check
              ? `${r.check.warnings} warning${r.check.warnings === 1 ? '' : 's'}, ${r.check.changes} change${r.check.changes === 1 ? '' : 's'} (check-report.json)`
              : 'no check report (run made before twopass check)'}
          </dd>
        </div>
      </dl>
    </header>
  );
}

const STATE_TEXT: Record<StageProgress['state'], string> = { waiting: 'Waiting', active: 'In progress', done: 'Done', skipped: 'Not needed' };

function Stages({ stages, active, status }: { stages: StageProgress[]; active: string | null; status: RunDetail['status'] }) {
  if (!stages.length) return null;
  return (
    <section aria-labelledby="stages-h" className="card">
      <h2 id="stages-h" className="card-title">
        Stages
      </h2>
      <ol className="stepper">
        {stages.map((s) => {
          const isActive = s.key === active;
          const stateText = isActive && status === 'stopped' ? 'Stopped here' : STATE_TEXT[s.state];
          const total = `${s.totalIsEstimate ? 'up to ' : ''}${formatCount(s.total)}`;
          return (
            <li key={s.key} className={`step step-${s.state}${isActive ? ' step-current' : ''}`} aria-current={isActive ? 'step' : undefined}>
              <div className="step-head">
                <span className="step-round">Round {s.round}</span>
                <span className="step-label">{s.label}</span>
              </div>
              <span className="step-state small">
                <span aria-hidden="true">{s.state === 'done' ? '✓ ' : s.state === 'skipped' ? '– ' : isActive ? '● ' : '○ '}</span>
                {stateText}
              </span>
              <ProgressBar
                value={share(s.done, s.total)}
                label={`${s.label}, round ${s.round}`}
                tone={s.state === 'done' ? 'ok' : 'accent'}
                indeterminate={s.totalIsEstimate}
              />
              <span className="small">
                {s.sent !== undefined ? (
                  <>
                    {formatCount(s.sent)} sent · {formatCount(s.done)} collected of {total}
                  </>
                ) : (
                  <>
                    {formatCount(s.done)} of {total} {s.key === 'triage' ? 'decided' : 'verified'}
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const SPEND_LABELS: Array<[keyof StageSpend, string]> = [
  ['triage', 'Triage'],
  ['write1', 'Write, round 1'],
  ['verify1', 'Verify, round 1'],
  ['write2', 'Re-run, round 2'],
  ['verify2', 'Verify, round 2'],
];

function SpendCard({ r }: { r: RunDetail }) {
  return (
    <Card title="Spend">
      <SpendVsCap spent={r.spentUsd} cap={r.maxUsd} scope={r.capScope} />
      <table className="kv">
        <caption className="sr-only">Spend by stage</caption>
        <tbody>
          {SPEND_LABELS.map(([k, label]) => (
            <tr key={k}>
              <th scope="row">{label}</th>
              <td className="num">{formatUsd(r.spend[k])}</td>
            </tr>
          ))}
          <tr className="total">
            <th scope="row">Total</th>
            <td className="num">{formatUsd(r.spend.total)}</td>
          </tr>
        </tbody>
      </table>
      <p className="muted small">In-flight batches count once they finish. Per 1,000 rows: {formatUsd((1000 * r.spend.total) / Math.max(r.rowCount, 1))}.</p>
    </Card>
  );
}

function OutcomesCard({ r }: { r: RunDetail }) {
  const o = r.outcomes;
  if (!o) {
    return (
      <Card title="Outcomes">
        <p className="muted">{r.problem ?? 'Not available.'}</p>
      </Card>
    );
  }
  const n = Math.max(r.rowCount, 1);
  const rows: Array<[string, number, string]> = [
    ['Accepted', o.accepted, `${formatCount(o.acceptedRound0)} in round 0`],
    ['Flagged for a human', o.flagged, r.review?.flagged ? `${formatCount(r.review.reviewed)} reviewed, ${formatCount(r.review.remaining)} to review` : ''],
    ['Pending', o.pending, ''],
  ];
  return (
    <Card title="Outcomes">
      <table className="kv">
        <caption className="sr-only">Row outcomes</caption>
        <tbody>
          {rows.map(([label, count, note]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td className="num">
                {formatCount(count)} <span className="muted">({formatPct(count / n, 1)})</span>
                {note && <div className="muted small">{note}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.precision ? (
        <p>
          Precision of accepted rows:{' '}
          <strong>{r.precision.of ? formatPct(r.precision.correct / r.precision.of, 1) : '—'}</strong>{' '}
          <span className="muted small">
            ({formatCount(r.precision.correct)} of {formatCount(r.precision.of)}, against <code>{r.manifest.labelColumn}</code>)
          </span>
        </p>
      ) : (
        <p className="muted small">No label column, so no precision.</p>
      )}
    </Card>
  );
}

function FinishCard({ r, now }: { r: RunDetail; now: number }) {
  return (
    <Card title="Expected finish">
      <p className="big">{r.status === 'finished' ? 'Finished' : formatEta(r.expectedFinish.at, now)}</p>
      <p className="muted small">
        {r.expectedFinish.at ? 'Rough estimate. ' : ''}
        {r.expectedFinish.basis}
      </p>
      {r.lastEventAt && <p className="small">Last ledger event {formatAgo(r.lastEventAt, now)}.</p>}
    </Card>
  );
}

function BalanceCard({ balance, runReserve, status }: { balance: BalanceResponse | null; runReserve: number; status: RunDetail['status'] }) {
  return (
    <Card title="OpenRouter balance">
      {!balance ? (
        <p className="muted">Loading…</p>
      ) : balance.available ? (
        <p className="big">
          {formatUsd(balance.balanceUsd)} <span className="muted small">available</span>
        </p>
      ) : (
        <p className="muted">{/OPENROUTER_API_KEY/.test(balance.reason) ? 'Set OPENROUTER_API_KEY to see your balance.' : balance.reason}</p>
      )}
      {balance && (
        <table className="kv">
          <caption className="sr-only">Estimated reserve</caption>
          <tbody>
            <tr>
              <th scope="row">Reserve, this run</th>
              <td className="num">{formatUsd(runReserve)}</td>
            </tr>
            <tr>
              <th scope="row">Reserve, all runs</th>
              <td className="num">
                {formatUsd(balance.reserve.totalUsd)}
                <span className="muted small"> ({balance.reserve.batches.length} batch{balance.reserve.batches.length === 1 ? '' : 'es'})</span>
              </td>
            </tr>
          </tbody>
        </table>
      )}
      <p className="muted small">
        Our estimate. While a batch runs, OpenRouter holds its worst case (every row at max_tokens) from your balance; a
        new batch that doesn’t fit fails with HTTP 402.
        {status !== 'running' && runReserve > 0 ? ' This run is not running, but its unfinished batch may still be held.' : ''}
      </p>
    </Card>
  );
}

function Batches({ batches, now }: { batches: BatchRow[]; now: number }) {
  return (
    <Card title="Batches" className="wide">
      {!batches.length ? (
        <p className="muted">No batches submitted yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Batch</th>
                <th scope="col" className="num">
                  Round
                </th>
                <th scope="col">Model</th>
                <th scope="col" className="num">
                  Rows
                </th>
                <th scope="col">Status</th>
                <th scope="col">Submitted</th>
                <th scope="col">Finished</th>
                <th scope="col" className="num">
                  Duration / age
                </th>
                <th scope="col" className="num">
                  Cost
                </th>
                <th scope="col" className="num">
                  Undecodable
                </th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.batchId}>
                  <td>
                    <code title={b.batchId}>{b.shortId}</code>
                  </td>
                  <td className="num">{b.round}</td>
                  <td title={b.model}>{shortModel(b.model)}</td>
                  <td className="num">{formatCount(b.rows)}</td>
                  <td>
                    {b.finished ? (
                      b.status
                    ) : (
                      <span className="inflight">
                        <span aria-hidden="true" className="pulse">
                          ●
                        </span>{' '}
                        {b.status.replace(/_/g, ' ')}
                      </span>
                    )}
                  </td>
                  <td>{formatTime(b.submittedAt)}</td>
                  <td>{formatTime(b.finishedAt)}</td>
                  <td className="num">
                    {b.finished ? formatDuration(b.durationMs) : <span>{formatDuration(now - Date.parse(b.submittedAt))} so far</span>}
                  </td>
                  <td className="num">{b.finished ? formatUsd(b.costUsd) : <span className="muted">{formatUsd(b.costUsd)} so far</span>}</td>
                  <td className="num">{b.undecodable || (b.finished ? '0' : '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Recent({ r, now }: { r: RunDetail; now: number }) {
  return (
    <Card title="Recent activity" className="wide">
      {!r.recent.length ? (
        <p className="muted">Nothing in the ledger yet.</p>
      ) : (
        <ol className="activity">
          {r.recent.map((a, i) => (
            <li key={`${a.at}-${i}`}>
              <time dateTime={a.at} title={a.at} className="muted small">
                {formatTime(a.at)} · {formatAgo(a.at, now)}
              </time>
              <span>{a.text}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
