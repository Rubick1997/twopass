import { useEffect, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { ExploreConfigResult, ExploreCostPer1k, ExploreReliability, ExploreResponse } from '../../../src/ui/api-types.ts';
import { shortModel } from '../../../src/ui/models.ts';
import { controllersFor, coverageCurve, NEVER, replay, type Controller, type CurvePoint, type Thresholds } from '../explore.ts';
import { formatPct, formatUsd, thresholdText } from '../format.ts';
import { benchHref } from '../hooks.ts';

// Results explorer: the test-split table, a threshold explorer that replays the calibration run,
// accuracy at coverage, and reliability. Charts are inline SVG coloured with the --s1..--s5 tokens.

const STAGES = ['triage', 'write1', 'verify1', 'write2', 'verify2'] as const;
const STAGE_NAME: Record<(typeof STAGES)[number], string> = {
  triage: 'Triage',
  write1: 'Write, round 1',
  verify1: 'Verify, round 1',
  write2: 'Write, round 2',
  verify2: 'Verify, round 2',
};
const MAX_LINES = 5;

export function ExplorePage({ id }: { id: string }) {
  const [state, setState] = useState<{ data: ExploreResponse | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    let live = true;
    setState({ data: null, error: null });
    fetch(`/api/benches/${encodeURIComponent(id)}/explore`, { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        const body = (await res.json()) as ExploreResponse & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        return body;
      })
      .then((data) => live && setState({ data, error: null }))
      .catch((err: Error) => live && setState({ data: null, error: err.message }));
    return () => {
      live = false;
    };
  }, [id]);

  const d = state.data;
  return (
    <>
      <p className="crumbs small">
        <a href="#/">All runs</a> · <a href={benchHref(id)}>{id}</a>
      </p>
      <h1 className="mono-title">Explore {id}</h1>
      {state.error && <p className="note note-error">{state.error}</p>}
      {!d && !state.error && <p className="muted">Loading…</p>}
      {d && <Explorer d={d} />}
    </>
  );
}

function Explorer({ d }: { d: ExploreResponse }) {
  const cal = d.calibration;
  return (
    <>
      <section aria-labelledby="results-h">
        <h2 id="results-h">Results on the test split</h2>
        <ResultsTable configs={d.results.configs} />
        <CostBars configs={d.results.configs} />
      </section>

      {cal ? (
        <Replay d={d} />
      ) : (
        <section aria-labelledby="replay-h">
          <h2 id="replay-h">Threshold explorer and accuracy at coverage</h2>
          <p className="note note-warn">
            Not available: {d.calibrationMissingReason ?? 'the calibration run is missing'}. The table above and the reliability charts below come from
            bench-report.json and still work.
          </p>
        </section>
      )}

      <section aria-labelledby="rel-h">
        <h2 id="rel-h">Reliability</h2>
        <Reliability items={d.reliability} />
      </section>
    </>
  );
}

// ---------------------------------------------------------------- 1. results

function ResultsTable({ configs }: { configs: ExploreConfigResult[] }) {
  return (
    <div className="card flush table-wrap">
      <table className="data">
        <caption className="sr-only">Results on the test split, one row per configuration and the baseline</caption>
        <thead>
          <tr>
            <th scope="col">Config</th>
            <th scope="col">Rows</th>
            <th scope="col" className="num">Auto-accepted</th>
            <th scope="col" className="num">Precision of auto-accepted</th>
            <th scope="col" className="num">Sent to a human</th>
            <th scope="col" className="num">Accuracy, no human</th>
            <th scope="col" className="num">Cost per 1k rows</th>
          </tr>
        </thead>
        <tbody>
          {configs.map((c) => (
            <tr key={c.name}>
              <th scope="row">{c.name}</th>
              <td className="num">{c.rows.toLocaleString('en-US')}</td>
              <td className="num">{formatPct(c.autoAcceptShare, 1)}</td>
              <td className="num">{formatPct(c.precision, 1)}</td>
              <td className="num">{formatPct(c.flaggedShare, 1)}</td>
              <td className="num">{formatPct(c.accuracyNoHuman, 1)}</td>
              <td className="num">{formatUsd(c.costPer1k.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CostBars({ configs }: { configs: ExploreConfigResult[] }) {
  const rowH = 34;
  const left = 96;
  const right = 64;
  const W = 720;
  const H = configs.length * rowH + 12;
  const max = Math.max(...configs.map((c) => stageTotal(c.costPer1k)), 1e-9);
  const plotW = W - left - right;
  const summary = configs.map((c) => `${c.name} ${formatUsd(c.costPer1k.total)}`).join(', ');
  return (
    <figure className="card viz">
      <figcaption className="card-title">Cost per 1,000 rows, by stage</figcaption>
      <Legend box items={STAGES.map((s, i) => ({ label: STAGE_NAME[s], slot: i + 1 }))} />
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Stacked bars of cost per 1,000 rows by stage. ${summary}. A table follows.`} className="chart">
        {configs.map((c, row) => {
          const y = 6 + row * rowH;
          let x = left;
          return (
            <g key={c.name}>
              <text x={left - 8} y={y + 14} textAnchor="end" className="ax">
                {c.name}
              </text>
              {STAGES.map((s, i) => {
                const v = c.costPer1k[s];
                if (v <= 0) return null;
                const w = (v / max) * plotW;
                const x0 = x;
                x += w;
                return (
                  <rect key={s} x={x0} y={y} width={Math.max(w - 2, 1)} height={22} rx={2} className={`s${i + 1}`}>
                    <title>{`${c.name}, ${STAGE_NAME[s]}: ${formatUsd(v)} per 1k rows`}</title>
                  </rect>
                );
              })}
              <text x={x + 6} y={y + 15} className="ax-strong">
                {formatUsd(c.costPer1k.total)}
              </text>
            </g>
          );
        })}
      </svg>
      <details>
        <summary>Table view</summary>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Config</th>
                {STAGES.map((s) => (
                  <th key={s} scope="col" className="num">
                    {STAGE_NAME[s]}
                  </th>
                ))}
                <th scope="col" className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {configs.map((c) => (
                <tr key={c.name}>
                  <th scope="row">{c.name}</th>
                  {STAGES.map((s) => (
                    <td key={s} className="num">
                      {formatUsd(c.costPer1k[s])}
                    </td>
                  ))}
                  <td className="num">{formatUsd(c.costPer1k.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

const stageTotal = (k: ExploreCostPer1k) => STAGES.reduce((n, s) => n + k[s], 0);

function Legend({ items, box = false }: { items: Array<{ label: string; slot: number; dashed?: boolean }>; box?: boolean }) {
  return (
    <ul className="legend">
      {items.map((it) => (
        <li key={it.label}>
          <svg width="22" height="10" aria-hidden="true">
            {box ? (
              <rect x="1" y="0" width="20" height="10" rx="2" className={`s${it.slot}`} />
            ) : (
              <line x1="1" y1="5" x2="21" y2="5" className={`line s${it.slot}`} strokeDasharray={it.dashed ? '4 3' : undefined} />
            )}
          </svg>
          {it.label}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- 2 and 3. replay

const clampT = (x: number) => Math.min(NEVER, Math.max(0.5, Math.round(x * 100) / 100));
const sameController = (a: Controller, b: Controller) => a.triage === b.triage && a.verify === b.verify;

function Replay({ d }: { d: ExploreResponse }) {
  const cal = d.calibration!;
  const rows = cal.data;
  const controllers = useMemo(() => controllersFor(rows, cal.models), [rows, cal.models]);
  // Bench configs that can be replayed, in report order.
  const presets = useMemo(
    () =>
      d.results.configs
        .filter((c): c is ExploreConfigResult & { triage: string; verify: string; thresholds: NonNullable<ExploreConfigResult['thresholds']> } =>
          !!c.triage && !!c.verify && !!c.thresholds,
        )
        .filter((c) => controllers.some((k) => sameController(k, { triage: c.triage, verify: c.verify }))),
    [d, controllers],
  );
  const first: Controller = presets[0] ? { triage: presets[0].triage, verify: presets[0].verify } : (controllers[0] ?? { triage: '', verify: '' });
  const [ctrl, setCtrl] = useState<Controller>(first);

  const preset = presets.find((p) => sameController(ctrl, { triage: p.triage, verify: p.verify }));
  const calibrated: Thresholds = useMemo(() => {
    if (preset) return preset.thresholds;
    const fit = (m: string, s: 'triage' | 'verify1' | 'verify2') => cal.fitsByModel[m]?.[s] ?? 0.95;
    return { t0: fit(ctrl.triage, 'triage'), t1: fit(ctrl.verify, 'verify1'), t2: fit(ctrl.verify, 'verify2') };
  }, [preset, cal, ctrl]);
  const [t, setT] = useState<Thresholds>(calibrated);
  useEffect(() => setT(calibrated), [calibrated]);

  const now = useMemo(() => replay(rows, ctrl, t), [rows, ctrl, t]);
  const base = useMemo(() => replay(rows, ctrl, calibrated), [rows, ctrl, calibrated]);
  const atCalibrated = t.t0 === calibrated.t0 && t.t1 === calibrated.t1 && t.t2 === calibrated.t2;

  const note = cal.pricingNote;
  return (
    <>
      <section aria-labelledby="replay-h">
        <h2 id="replay-h">Threshold explorer</h2>
        <p className="note">
          Replayed on <strong>{cal.rows.toLocaleString('en-US')} held-out calibration rows (train split), not the test split</strong>. Every row went
          through every stage there, so any thresholds can be applied after the fact. Numbers here will differ from the test-split table.
        </p>
        <div className="card">
          <div className="controls">
            <label>
              Preset
              <select
                value={preset ? preset.name : ''}
                onChange={(e) => {
                  const p = presets.find((x) => x.name === e.target.value);
                  if (p) setCtrl({ triage: p.triage, verify: p.verify });
                }}
              >
                {!preset && <option value="">Custom combination</option>}
                {presets.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Triage model
              <select value={ctrl.triage} onChange={(e) => setCtrl({ ...ctrl, triage: e.target.value })}>
                {[...new Set(controllers.map((c) => c.triage))].map((m) => (
                  <option key={m} value={m}>
                    {shortModel(m)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Verify model
              <select value={ctrl.verify} onChange={(e) => setCtrl({ ...ctrl, verify: e.target.value })}>
                {[...new Set(controllers.map((c) => c.verify))].map((m) => (
                  <option key={m} value={m}>
                    {shortModel(m)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="sliders">
            <Slider id="t0" label="t0, triage accepts at or above" value={t.t0} onChange={(v) => setT({ ...t, t0: v })} />
            <Slider id="t1" label="t1, round-1 verify accepts at or above" value={t.t1} onChange={(v) => setT({ ...t, t1: v })} />
            <Slider id="t2" label="t2, round-2 verify accepts at or above" value={t.t2} onChange={(v) => setT({ ...t, t2: v })} />
          </div>
          <p>
            <button type="button" className="btn" onClick={() => setT(calibrated)} disabled={atCalibrated}>
              Reset to calibrated
            </button>
            <span className="muted small">
              {' '}
              calibrated: {thresholdText(calibrated.t0)} / {thresholdText(calibrated.t1)} / {thresholdText(calibrated.t2)}
              {preset ? '' : ' (from each model\'s own fit; 0.95 where it has none)'}
            </span>
          </p>
          <div className="tiles" aria-live="polite">
            <Tile label="Auto-accepted" value={formatPct(now.acceptedShare, 1)} delta={pts(now.acceptedShare, base.acceptedShare)} />
            <Tile label="Precision of accepted" value={formatPct(now.precision, 1)} delta={now.precision === null || base.precision === null ? '' : pts(now.precision, base.precision)} />
            <Tile label="Sent to a human" value={formatPct(now.flaggedShare, 1)} delta={pts(now.flaggedShare, base.flaggedShare)} />
            <Tile label="Accuracy, no human" value={formatPct(now.accuracyNoHuman, 1)} delta={pts(now.accuracyNoHuman, base.accuracyNoHuman)} />
            <Tile label="Cost per 1k rows" value={formatUsd(now.costPer1k.total)} delta={usdDelta(now.costPer1k.total, base.costPer1k.total)} />
          </div>
          <p className="muted small">Change is against the calibrated thresholds of the same controller. {note && <span className="pricing-note">{note}</span>}</p>
        </div>
      </section>

      <section aria-labelledby="cov-h">
        <h2 id="cov-h">Accuracy at coverage</h2>
        <CoverageChart d={d} ctrl={ctrl} preset={preset?.name ?? null} calibrated={calibrated} current={t} />
      </section>
    </>
  );
}

const pts = (a: number, b: number) => {
  const x = 100 * (a - b);
  return Math.abs(x) < 0.05 ? 'same' : `${x > 0 ? '+' : '−'}${Math.abs(x).toFixed(1)} pts`;
};
const usdDelta = (a: number, b: number) => (Math.abs(a - b) < 0.00005 ? 'same' : `${a > b ? '+' : '−'}${formatUsd(Math.abs(a - b))}`);

function Tile({ label, value, delta }: { label: string; value: string; delta: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      <div className="tile-delta muted small">{delta ? `${delta} vs calibrated` : '—'}</div>
    </div>
  );
}

function Slider({ id, label, value, onChange }: { id: string; label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="slider">
      <label htmlFor={`sl-${id}`}>{label}</label>
      <div className="slider-row">
        <input
          id={`sl-${id}`}
          type="range"
          min={0.5}
          max={NEVER}
          step={0.01}
          value={value}
          aria-valuetext={thresholdText(value)}
          onChange={(e) => onChange(clampT(Number(e.target.value)))}
        />
        <output htmlFor={`sl-${id}`} className="slider-value">
          {thresholdText(value)}
        </output>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 3. coverage chart

function CoverageChart({
  d,
  ctrl,
  preset,
  calibrated,
  current,
}: {
  d: ExploreResponse;
  ctrl: Controller;
  preset: string | null;
  calibrated: Thresholds;
  current: Thresholds;
}) {
  const cal = d.calibration!;
  const rows = cal.data;
  const lines = useMemo(() => {
    const out: Array<{ name: string; ctrl: Controller; curve: CurvePoint[] }> = [];
    for (const c of d.results.configs) {
      if (!c.triage || !c.verify) continue;
      const k = { triage: c.triage, verify: c.verify };
      if (!controllersFor(rows, cal.models).some((x) => sameController(x, k))) continue;
      out.push({ name: c.name, ctrl: k, curve: coverageCurve(rows, k) });
    }
    return out.slice(0, MAX_LINES);
  }, [d, rows, cal.models]);
  const custom = preset === null && lines.length < MAX_LINES;
  const all = custom ? [...lines, { name: 'selected controller', ctrl, curve: coverageCurve(rows, ctrl) }] : lines;

  const W = 720;
  const H = 380;
  const m = { l: 56, r: 24, t: 16, b: 48 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const prec = all.flatMap((l) => l.curve.map((p) => p.precision)).filter((p): p is number => p !== null);
  const yMin = Math.max(0, Math.floor((Math.min(...prec, d.target) - 0.02) * 20) / 20);
  const X = (s: number) => m.l + s * pw;
  const Y = (p: number) => m.t + (1 - (p - yMin) / (1 - yMin)) * ph;
  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + ((1 - yMin) * i) / 4);

  const selected = all.find((l) => (preset !== null ? l.name === preset : l.name === 'selected controller'));
  const calPoint = replay(rows, ctrl, calibrated);
  const curPoint = replay(rows, ctrl, current);

  const [cursor, setCursor] = useState<number | null>(null);
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    setCursor(Math.min(1, Math.max(0, (x - m.l) / pw)));
  };
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setCursor((c) => Math.min(1, Math.max(0, (c ?? 0.5) + (e.key === 'ArrowRight' ? 0.01 : -0.01))));
    } else if (e.key === 'Escape') setCursor(null);
  };
  const readout =
    cursor === null
      ? null
      : all.map((l) => {
          const p = nearest(l.curve, cursor);
          return `${l.name}: ${formatPct(p?.acceptedShare, 1)} accepted, precision ${formatPct(p?.precision, 1)} at t = ${p?.t.toFixed(2)}`;
        });

  const summary = all
    .map((l) => {
      const hi = l.curve[0];
      const lo = l.curve[l.curve.length - 1];
      return `${l.name}: from ${formatPct(hi?.acceptedShare)} accepted at precision ${formatPct(hi?.precision)} (t 0.50) to ${formatPct(lo?.acceptedShare)} at ${formatPct(lo?.precision)} (t 1.00)`;
    })
    .join('; ');

  return (
    <figure className="card viz">
      <figcaption className="card-title">
        Precision of accepted rows against the share auto-accepted, sweeping one threshold t = t0 = t1 = t2 from 0.50 to 1.00 (calibration rows, train split)
      </figcaption>
      <Legend items={[...all.map((l, i) => ({ label: l.name, slot: i + 1 })), { label: `target ${formatPct(d.target)}`, slot: 0, dashed: true }]} />
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart"
        role="img"
        aria-label={`Line chart, accepted share on x, precision of accepted on y. ${summary}. Target precision ${formatPct(d.target)}. Arrow keys move a readout; a table view is below.`}
        tabIndex={0}
        onPointerMove={move}
        onPointerLeave={() => setCursor(null)}
        onKeyDown={key}
        onBlur={() => setCursor(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={m.l} x2={W - m.r} y1={Y(v)} y2={Y(v)} className="grid" />
            <text x={m.l - 8} y={Y(v) + 4} textAnchor="end" className="ax">
              {formatPct(v)}
            </text>
          </g>
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <text key={v} x={X(v)} y={H - m.b + 18} textAnchor="middle" className="ax">
            {formatPct(v)}
          </text>
        ))}
        <text x={m.l + pw / 2} y={H - 6} textAnchor="middle" className="ax">
          Auto-accepted share of rows
        </text>
        <text transform={`translate(14 ${m.t + ph / 2}) rotate(-90)`} textAnchor="middle" className="ax">
          Precision of accepted
        </text>
        <line x1={m.l} x2={W - m.r} y1={Y(d.target)} y2={Y(d.target)} className="target" />
        <text x={W - m.r - 4} y={Y(d.target) - 5} textAnchor="end" className="ax">
          target {formatPct(d.target)}
        </text>
        {all.map((l, i) => (
          <path key={l.name} d={path(l.curve, X, Y)} className={`line s${i + 1}${l === selected ? '' : ' dim'}`} />
        ))}
        {cursor !== null && <line x1={X(cursor)} x2={X(cursor)} y1={m.t} y2={m.t + ph} className="cursor" />}
        {calPoint.precision !== null && (
          <g>
            <rect x={X(calPoint.acceptedShare) - 6} y={Y(calPoint.precision) - 6} width={12} height={12} className="mark-cal" transform={`rotate(45 ${X(calPoint.acceptedShare)} ${Y(calPoint.precision)})`}>
              <title>{`Calibrated thresholds: ${formatPct(calPoint.acceptedShare, 1)} accepted, precision ${formatPct(calPoint.precision, 1)}`}</title>
            </rect>
          </g>
        )}
        {curPoint.precision !== null && (
          <circle cx={X(curPoint.acceptedShare)} cy={Y(curPoint.precision)} r={5} className="mark-cur">
            <title>{`Slider position: ${formatPct(curPoint.acceptedShare, 1)} accepted, precision ${formatPct(curPoint.precision, 1)}`}</title>
          </circle>
        )}
      </svg>
      <p className="small chart-key">
        <span aria-hidden="true">◇</span> calibrated point of the selected controller · <span aria-hidden="true">●</span> current slider position. Precision is undefined where nothing is accepted.
      </p>
      <p className="small readout" aria-live="polite">
        {readout ? readout.join(' · ') : 'Hover or focus the chart (arrow keys) to read values.'}
      </p>
      <details>
        <summary>Table view</summary>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">t</th>
                {all.map((l) => (
                  <th key={l.name} scope="col" className="num">
                    {l.name}: accepted / precision
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 11 }, (_, i) => i * 5).map((i) => (
                <tr key={i}>
                  <th scope="row">{(0.5 + i / 100).toFixed(2)}</th>
                  {all.map((l) => {
                    const p = l.curve[i];
                    return (
                      <td key={l.name} className="num">
                        {formatPct(p?.acceptedShare, 1)} / {formatPct(p?.precision, 1)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function nearest(curve: CurvePoint[], share: number): CurvePoint | undefined {
  let best: CurvePoint | undefined;
  for (const p of curve) if (p.precision !== null && (!best || Math.abs(p.acceptedShare - share) < Math.abs(best.acceptedShare - share))) best = p;
  return best;
}

function path(curve: CurvePoint[], X: (s: number) => number, Y: (p: number) => number): string {
  let out = '';
  let pen = false;
  for (const p of curve) {
    if (p.precision === null) {
      pen = false;
      continue;
    }
    out += `${pen ? 'L' : 'M'}${X(p.acceptedShare).toFixed(1)} ${Y(p.precision).toFixed(1)}`;
    pen = true;
  }
  return out;
}

// ---------------------------------------------------------------- 4. reliability

function Reliability({ items }: { items: ExploreReliability[] }) {
  if (!items.length) return <p className="muted">No reliability data in bench-report.json.</p>;
  return (
    <>
      <p className="muted small">
        Probability the decision model gave (x) against how often it was right (y), on the test-split rows, raw and after the isotonic fit from the calibration
        slice. On the diagonal means well calibrated.
      </p>
      <ul className="legend">
        <li>
          <svg width="22" height="10" aria-hidden="true">
            <circle cx="11" cy="5" r="4" className="dot-raw" />
          </svg>
          raw
        </li>
        <li>
          <svg width="22" height="10" aria-hidden="true">
            <circle cx="11" cy="5" r="4" className="dot-cal" />
          </svg>
          calibrated
        </li>
      </ul>
      <div className="rel-grid">
        {items.map((r) => (
          <ReliabilityChart key={`${r.config}/${r.stage}`} r={r} />
        ))}
      </div>
    </>
  );
}

function ReliabilityChart({ r }: { r: ExploreReliability }) {
  const S = 180;
  const m = 28;
  const P = S - m - 8;
  const X = (v: number) => m + v * P;
  const Y = (v: number) => 8 + (1 - v) * P;
  const raw = r.raw.filter((b) => b.n > 0);
  const cal = r.calibrated.filter((b) => b.n > 0);
  const title = `${r.config} · ${r.stage} (${shortModel(r.model)})`;
  const caption = `ECE ${r.eceRaw.toFixed(3)} → ${r.eceCalibrated.toFixed(3)}, n = ${r.n}`;
  return (
    <figure className="rel">
      <figcaption>
        <strong>{title}</strong>
        <br />
        <span className="muted small">{caption}</span>
      </figcaption>
      <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label={`Reliability, ${title}. ${caption}. Table follows.`} className="chart">
        <rect x={m} y={8} width={P} height={P} className="frame" />
        <line x1={X(0)} y1={Y(0)} x2={X(1)} y2={Y(1)} className="diag" />
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <text x={X(v)} y={S - 12} textAnchor="middle" className="ax-s">
              {v}
            </text>
            <text x={m - 4} y={Y(v) + 3} textAnchor="end" className="ax-s">
              {v}
            </text>
          </g>
        ))}
        <path d={bins(raw, X, Y)} className="rel-line raw" />
        <path d={bins(cal, X, Y)} className="rel-line cal" />
        {raw.map((b) => (
          <circle key={`r${b.lo}`} cx={X(b.meanP)} cy={Y(b.accuracy)} r={4} className="dot-raw">
            <title>{`raw ${b.lo.toFixed(1)}–${b.hi.toFixed(1)}: mean p ${b.meanP.toFixed(2)}, accuracy ${b.accuracy.toFixed(2)}, n ${b.n}`}</title>
          </circle>
        ))}
        {cal.map((b) => (
          <circle key={`c${b.lo}`} cx={X(b.meanP)} cy={Y(b.accuracy)} r={4} className="dot-cal">
            <title>{`calibrated ${b.lo.toFixed(1)}–${b.hi.toFixed(1)}: mean p ${b.meanP.toFixed(2)}, accuracy ${b.accuracy.toFixed(2)}, n ${b.n}`}</title>
          </circle>
        ))}
      </svg>
      <table className="sr-only">
        <caption>{`${title}: ${caption}`}</caption>
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">Bin</th>
            <th scope="col">Rows</th>
            <th scope="col">Mean probability</th>
            <th scope="col">Accuracy</th>
          </tr>
        </thead>
        <tbody>
          {[...raw.map((b) => ['raw', b] as const), ...cal.map((b) => ['calibrated', b] as const)].map(([v, b]) => (
            <tr key={`${v}${b.lo}`}>
              <th scope="row">{v}</th>
              <td>{`${b.lo.toFixed(1)} to ${b.hi.toFixed(1)}`}</td>
              <td>{b.n}</td>
              <td>{b.meanP.toFixed(2)}</td>
              <td>{b.accuracy.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function bins(bs: Array<{ meanP: number; accuracy: number }>, X: (v: number) => number, Y: (v: number) => number): string {
  return bs.map((b, i) => `${i ? 'L' : 'M'}${X(b.meanP).toFixed(1)} ${Y(b.accuracy).toFixed(1)}`).join('');
}
