import type { BenchConfigSummary, BenchesResponse, RunListItem, RunsResponse } from '../../../src/ui/api-types.ts';
import { ErrorNote, ModeTag, ModelsLine, ProgressBar, SpendVsCap, StatusBadge } from '../components.tsx';
import { formatAgo, formatCount, formatDateTime, formatPct, formatUsd } from '../format.ts';
import { benchHref, exploreHref, reviewHref, runHref, usePoll, useNow } from '../hooks.ts';

export function Home() {
  const runs = usePoll<RunsResponse>('/api/runs');
  const benches = usePoll<BenchesResponse>('/api/benches');
  const now = useNow(5000);

  if (!runs.data || !benches.data) {
    return (
      <>
        <h1>Runs and benches</h1>
        {runs.error || benches.error ? <ErrorNote error={runs.error ?? benches.error} /> : <p className="muted">Loading…</p>}
      </>
    );
  }
  const inBench = new Set(benches.data.benches.flatMap((b) => [b.calibration?.runId, ...b.configs.map((c) => c.runId)]).filter(Boolean));
  const standalone = runs.data.runs.filter((r) => !inBench.has(r.runId));
  const empty = !standalone.length && !benches.data.benches.length;

  return (
    <>
      <h1>Runs and benches</h1>
      <p className="muted small">
        Reading <code>{runs.data.runsRoot}</code>, newest first.
      </p>
      <ErrorNote error={runs.error ?? benches.error} />

      {empty && (
        <section className="card empty">
          <h2 className="card-title">No runs yet</h2>
          <p>Start one, and it shows up here within a few seconds:</p>
          <pre>
            <code>twopass run my.csv --task tasks/my.task.ts --max-usd 2</code>
          </pre>
          <p className="muted">
            To see the monitor without spending anything: <code>node scripts/fake-live-run.ts --runs {runs.data.runsRoot}</code>
          </p>
        </section>
      )}

      {benches.data.benches.length > 0 && (
        <section aria-labelledby="benches-h">
          <h2 id="benches-h">Benches</h2>
          {benches.data.benches.map((b) => (
            <article key={b.benchId} className="card bench">
              <header className="bench-head">
                <h3>
                  <a href={benchHref(b.benchId)}>{b.benchId}</a>
                </h3>
                <StatusBadge status={b.status} />
                <span className="muted small">started {formatDateTime(b.createdAt)}</span>
                {b.hasReport && (
                  <a href={exploreHref(b.benchId)} className="small">
                    Explore results
                  </a>
                )}
                <span className="push">
                  <strong>{formatUsd(b.spentUsd)}</strong>
                  <span className="muted">{b.maxUsd !== null ? ` of ${formatUsd(b.maxUsd)} cap` : ''}</span>
                </span>
              </header>
              <RunTable rows={[...(b.calibration ? [b.calibration] : []), ...b.configs]} now={now} />
            </article>
          ))}
        </section>
      )}

      {standalone.length > 0 && (
        <section aria-labelledby="runs-h">
          <h2 id="runs-h">Runs</h2>
          <div className="card flush">
            <RunTable rows={standalone.map((r) => ({ name: '', runId: r.runId, run: r }))} now={now} />
          </div>
        </section>
      )}
    </>
  );
}

function RunTable({ rows, now }: { rows: BenchConfigSummary[]; now: number }) {
  const named = rows.some((r) => r.name);
  return (
    <div className="table-wrap">
      <table className="runs">
        <thead>
          <tr>
            {named && <th scope="col">Config</th>}
            <th scope="col">Run</th>
            <th scope="col">Status</th>
            <th scope="col">Models</th>
            <th scope="col" className="num">
              Rows
            </th>
            <th scope="col" className="progress-col">
              Progress
            </th>
            <th scope="col">Spend</th>
            <th scope="col">Last change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <RunRow key={r.runId} name={named ? r.name : null} runId={r.runId} run={r.run} now={now} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunRow({ name, runId, run, now }: { name: string | null; runId: string; run: RunListItem | null; now: number }) {
  if (!run) {
    return (
      <tr>
        {name !== null && <td>{name}</td>}
        <td>
          <code>{runId}</code>
        </td>
        <td colSpan={6} className="muted">
          Not created yet
        </td>
      </tr>
    );
  }
  const o = run.outcomes;
  const done = o ? run.rowCount - o.pending : 0;
  return (
    <tr>
      {name !== null && <td className="strong">{name}</td>}
      <td>
        <a href={runHref(run.runId)} className="run-link">
          {run.runId}
        </a>
        <div>
          <ModeTag mode={run.mode} />
        </div>
      </td>
      <td>
        <StatusBadge status={run.status} activity={run.activity} />
      </td>
      <td>
        <ModelsLine models={run.models} mode={run.mode} />
      </td>
      <td className="num">{formatCount(run.rowCount)}</td>
      <td className="progress-col">
        <ProgressBar value={run.progress} label={`Progress of ${run.runId}`} tone={run.status === 'finished' ? 'ok' : 'accent'} />
        <span className="small muted">
          {o ? `${formatCount(done)} done (${formatPct(run.progress)}) · ${formatCount(o.accepted)} accepted · ${formatCount(o.flagged)} flagged` : (run.problem ?? '—')}
        </span>
        <ReviewLink runId={run.runId} review={run.review} />
      </td>
      <td>
        <SpendVsCap spent={run.spentUsd} cap={run.maxUsd} scope={run.capScope} />
      </td>
      <td className="small">
        <span title={run.lastEventAt ?? run.createdAt}>{formatAgo(run.lastEventAt ?? run.createdAt, now)}</span>
        <div className="muted">started {formatDateTime(run.createdAt)}</div>
      </td>
    </tr>
  );
}

/** "12 to review" (or "all 40 reviewed") linking to the review queue; nothing when no row was flagged. */
export function ReviewLink({ runId, review }: { runId: string; review: RunListItem['review'] }) {
  if (!review || !review.flagged) return null;
  return (
    <div className="small">
      <a href={reviewHref(runId)}>
        {review.remaining ? `${formatCount(review.remaining)} to review` : `all ${formatCount(review.flagged)} reviewed`}
      </a>
    </div>
  );
}
