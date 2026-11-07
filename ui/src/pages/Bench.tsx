import { Fragment, useEffect, useState } from 'react';
import type { BenchConfigSummary, BenchDetail, BenchReportResponse } from '../../../src/ui/api-types.ts';
import { CopyButton, ErrorNote, ModelsLine, ProgressBar, SpendVsCap, StatusBadge } from '../components.tsx';
import { formatCount, formatDateTime, formatPct } from '../format.ts';
import { runHref, usePoll, useNow } from '../hooks.ts';
import { parseMarkdown, type Block, type Inline } from '../markdown.ts';

export function BenchPage({ id }: { id: string }) {
  const bench = usePoll<BenchDetail>(`/api/benches/${encodeURIComponent(id)}`);
  useNow(5000);
  const b = bench.data;
  if (!b) {
    return (
      <>
        <h1 className="mono-title">{id}</h1>
        {bench.error ? <p className="note note-error">{bench.error}</p> : <p className="muted">Loading…</p>}
      </>
    );
  }
  return (
    <>
      <p className="crumbs small">
        <a href="#/">All runs</a>
      </p>
      <h1 className="mono-title">{b.benchId}</h1>
      <div className="head-line">
        <StatusBadge status={b.status} />
        <span className="muted">started {formatDateTime(b.createdAt)}</span>
      </div>
      <ErrorNote error={bench.error} />
      <SpendVsCap spent={b.spentUsd} cap={b.maxUsd} scope="run" />
      {b.resumeCommand && (
        <div className="resume">
          <span>Stopped. Continue with:</span>
          <code className="cmd">{b.resumeCommand}</code>
          <CopyButton text={b.resumeCommand} label="Copy command" />
        </div>
      )}

      <section aria-labelledby="configs-h">
        <h2 id="configs-h">Configurations</h2>
        <div className="config-grid">
          {b.configs.map((c) => (
            <ConfigCard key={c.name} c={c} />
          ))}
        </div>
      </section>

      {b.calibration && (
        <section aria-labelledby="calib-h">
          <h2 id="calib-h">Calibration run</h2>
          <div className="config-grid">
            <ConfigCard c={b.calibration} />
          </div>
        </section>
      )}

      <section aria-labelledby="report-h">
        <h2 id="report-h">Report</h2>
        {b.hasReport ? <Report benchId={b.benchId} /> : <p className="muted">No bench-report.md yet. It is written when every run has finished.</p>}
      </section>
    </>
  );
}

function ConfigCard({ c }: { c: BenchConfigSummary }) {
  const r = c.run;
  return (
    <article className="card config">
      <h3>{c.name}</h3>
      {!r ? (
        <p className="muted">Run {c.runId} not created yet.</p>
      ) : (
        <>
          <StatusBadge status={r.status} activity={r.activity} />
          <p className="small">
            <ModelsLine models={r.models} mode={r.mode} />
          </p>
          <ProgressBar value={r.progress} label={`Progress of ${c.name}`} tone={r.status === 'finished' ? 'ok' : 'accent'} />
          <p className="small">
            {r.outcomes
              ? `${formatCount(r.rowCount - r.outcomes.pending)} of ${formatCount(r.rowCount)} rows done (${formatPct(r.progress)})`
              : (r.problem ?? '—')}
          </p>
          {r.outcomes && (
            <p className="small">
              {formatCount(r.outcomes.accepted)} accepted · {formatCount(r.outcomes.flagged)} flagged
            </p>
          )}
          <SpendVsCap spent={r.spentUsd} cap={null} scope={null} />
          <p>
            <a href={runHref(r.runId)}>Open run {r.runId}</a>
          </p>
        </>
      )}
    </article>
  );
}

function Report({ benchId }: { benchId: string }) {
  const [state, setState] = useState<{ md: string | null; error: string | null }>({ md: null, error: null });
  useEffect(() => {
    let live = true;
    fetch(`/api/benches/${encodeURIComponent(benchId)}/report`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return ((await res.json()) as BenchReportResponse).markdown;
      })
      .then((md) => live && setState({ md, error: null }))
      .catch((err: Error) => live && setState({ md: null, error: err.message }));
    return () => {
      live = false;
    };
  }, [benchId]);
  if (state.error) return <p className="note note-error">Could not load the report: {state.error}</p>;
  if (state.md === null) return <p className="muted">Loading…</p>;
  return (
    <div className="card report">
      {parseMarkdown(state.md).map((block, i) => (
        <MdBlock key={i} block={block} />
      ))}
    </div>
  );
}

function MdInline({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'code' ? <code key={i}>{p.text}</code> : p.kind === 'bold' ? <strong key={i}>{p.text}</strong> : <Fragment key={i}>{p.text}</Fragment>,
      )}
    </>
  );
}

function MdBlock({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading': {
      // The page already has h1/h2; the report's headings start at h3.
      const Tag = (['h3', 'h3', 'h4', 'h5', 'h6'] as const)[block.level] ?? 'h6';
      return (
        <Tag>
          <MdInline parts={block.text} />
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p>
          <MdInline parts={block.text} />
        </p>
      );
    case 'list':
      return (
        <ul>
          {block.items.map((item, i) => (
            <li key={i}>
              <MdInline parts={item} />
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {block.header.map((h, i) => (
                  <th key={i} scope="col">
                    <MdInline parts={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>
                      <MdInline parts={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}
