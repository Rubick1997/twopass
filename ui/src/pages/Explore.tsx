import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { ExploreConfigResult, ExploreCostPer1k, ExploreReliability, ExploreResponse } from '../../../src/ui/api-types.ts';
import {
  bestConfig,
  cardStats,
  configDescription,
  costFootnoteText,
  controllersFor,
  coverageCurve,
  friendlyConfig,
  friendlyModel,
  NEVER,
  outcomeSentence,
  refitThresholds,
  replay,
  uncachedTag,
  waffleCounts,
  type Controller,
  type CurvePoint,
  type ReplayResult,
  type Thresholds,
} from '../explore.ts';
import { formatPct, formatUsd, thresholdText } from '../format.ts';
import { benchHref, exploreHref } from '../hooks.ts';

// The results explorer, for people deciding whether to trust a model with a spreadsheet of repetitive work.
// Three tabs: "Try it" (one accuracy slider, refitted live with fitThreshold, and a 100-row waffle), "Results"
// (the test split in plain words) and "How it was tested" (the technical charts, each term explained once).
// Charts are inline SVG coloured with the --s1..--s5 tokens; the waffle uses the status tokens plus a shape per state.

const STAGES = ['triage', 'write1', 'verify1', 'write2', 'verify2'] as const;
/** Plain names of the pipeline's steps, used everywhere a stage is shown to the reader. */
const STEP: Record<(typeof STAGES)[number], string> = {
  triage: 'Step 1: quick answer',
  write1: 'Step 2: cheap model writes',
  verify1: 'Step 2: check the cheap model’s answer',
  write2: 'Step 3: stronger model writes',
  verify2: 'Step 3: check the stronger model’s answer',
};
const MAX_LINES = 5;

const TABS = [
  { key: 'try', label: 'Try it' },
  { key: 'results', label: 'Results' },
  { key: 'method', label: 'How it was tested' },
] as const;
type TabKey = (typeof TABS)[number]['key'];
const isTab = (x: string | undefined): x is TabKey => TABS.some((t) => t.key === x);

export function ExplorePage({ id, tab }: { id: string; tab?: string }) {
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
  const date = d?.createdAt ? new Date(d.createdAt) : null;
  return (
    <>
      <nav aria-label="Breadcrumb" className="crumbs small">
        <a href="#/">All runs</a> <span aria-hidden="true">›</span> <a href={benchHref(id)}>{id}</a> <span aria-hidden="true">›</span>{' '}
        <span aria-current="page">Explore</span>
      </nav>
      <h1>What happens to your rows</h1>
      <p className="muted lede">
        A benchmark run on {date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }) : 'an unknown date'}{' '}
        <span className="mono-id">({id})</span>. It tells you which answers you can trust without checking, and how many you will have to check yourself.
      </p>
      {state.error && <p className="note note-error">{state.error}</p>}
      {!d && !state.error && <p className="muted">Loading…</p>}
      {d && <Explorer d={d} tab={isTab(tab) ? tab : 'try'} />}
    </>
  );
}

// ---------------------------------------------------------------- tabs

function Explorer({ d, tab }: { d: ExploreResponse; tab: TabKey }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const go = (key: TabKey) => {
    window.location.hash = exploreHref(d.benchId, key);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.key === tab);
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    else return;
    e.preventDefault();
    const key = TABS[next]!.key;
    go(key);
    refs.current[next]?.focus();
  };
  return (
    <>
      <div className="tabs" role="tablist" aria-label="Sections" onKeyDown={onKey}>
        {TABS.map((t, i) => (
          <button
            key={t.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${t.key}`}
            aria-selected={t.key === tab}
            aria-controls={`panel-${t.key}`}
            tabIndex={t.key === tab ? 0 : -1}
            className="tab"
            onClick={() => go(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="panel-try" aria-labelledby="tab-try" hidden={tab !== 'try'} className="panel">
        <TryIt d={d} />
      </div>
      <div role="tabpanel" id="panel-results" aria-labelledby="tab-results" hidden={tab !== 'results'} className="panel">
        <Results d={d} />
      </div>
      <div role="tabpanel" id="panel-method" aria-labelledby="tab-method" hidden={tab !== 'method'} className="panel">
        <Method d={d} />
      </div>
    </>
  );
}

/** A one-sentence explanation behind a disclosure, never a hover tooltip. */
function Why({ children, label = 'What does this mean?' }: { children: ReactNode; label?: string }) {
  return (
    <details className="why">
      <summary>{label}</summary>
      <p>{children}</p>
    </details>
  );
}

const sameController = (a: Controller, b: Controller) => a.triage === b.triage && a.verify === b.verify;
type Preset = ExploreConfigResult & { triage: string; verify: string; thresholds: Thresholds };

function presetsOf(d: ExploreResponse, controllers: Controller[]): Preset[] {
  return d.results.configs
    .filter((c): c is Preset => !!c.triage && !!c.verify && !!c.thresholds)
    .filter((c) => controllers.some((k) => sameController(k, { triage: c.triage, verify: c.verify })));
}

const baselineOf = (d: ExploreResponse) => d.results.configs.find((c) => c.name === 'baseline' && !c.triage && !c.verify) ?? null;

/** One footnote for every cost figure on the page, when the bench's writer costs were recorded without caching. */
function CostFootnote({ d }: { d: ExploreResponse }) {
  const text = costFootnoteText(d.calibration?.pricingNote);
  if (!text) return null;
  return (
    <p className="small muted footnote" id="cost-note">
      {text}
    </p>
  );
}

const Star = ({ d }: { d: ExploreResponse }) => {
  const tag = uncachedTag(d.calibration?.pricingNote);
  if (!tag) return null;
  return (
    <>
      {' '}
      <span className="uncached">{tag}</span>
      <a href="#cost-note" className="star" aria-label="see the cost footnote">*</a>
    </>
  );
};

// ---------------------------------------------------------------- 1. Try it

const clampT = (x: number) => Math.min(NEVER, Math.max(0.5, Math.round(x * 100) / 100));

function TryIt({ d }: { d: ExploreResponse }) {
  const cal = d.calibration;
  if (!cal) {
    return (
      <section aria-labelledby="try-h">
        <h2 id="try-h" className="sr-only">
          Try it
        </h2>
        <p className="note note-warn">
          This part needs the benchmark’s example rows, which are not available: {d.calibrationMissingReason ?? 'the calibration run is missing'}. The
          Results and How-it-was-tested tabs still work.
        </p>
      </section>
    );
  }
  return <TryItInner d={d} />;
}

function TryItInner({ d }: { d: ExploreResponse }) {
  const cal = d.calibration!;
  const rows = cal.data;
  const controllers = useMemo(() => controllersFor(rows, cal.models), [rows, cal.models]);
  const presets = useMemo(() => presetsOf(d, controllers), [d, controllers]);
  const bestName = bestConfig(d.results.configs, d.target);
  const start = presets.find((p) => p.name === bestName) ?? presets[0];
  const first: Controller = start ? { triage: start.triage, verify: start.verify } : (controllers[0] ?? { triage: '', verify: '' });
  const [ctrl, setCtrl] = useState<Controller>(first);
  const preset = presets.find((p) => sameController(ctrl, { triage: p.triage, verify: p.verify }));

  const [targetPct, setTargetPct] = useState(Math.min(99, Math.max(80, Math.round(d.target * 100))));
  const fitted = useMemo(() => refitThresholds(rows, ctrl, targetPct / 100), [rows, ctrl, targetPct]);
  const [manual, setManual] = useState<Thresholds | null>(null);
  const t = manual ?? fitted;
  const now = useMemo(() => replay(rows, ctrl, t), [rows, ctrl, t]);
  const counts = waffleCounts(now);
  const base = baselineOf(d);

  const pickTarget = (v: number) => {
    setTargetPct(v);
    setManual(null);
  };
  const pickCtrl = (k: Controller) => {
    setCtrl(k);
    setManual(null);
  };
  const triageModels = [...new Set(controllers.map((c) => c.triage))];
  const verifyModels = [...new Set(controllers.map((c) => c.verify))];

  return (
    <>
      <section aria-labelledby="setup-h">
        <h2 id="setup-h">1. Which setup?</h2>
        <fieldset className="pick">
          <legend className="sr-only">Setup</legend>
          {presets.map((p) => {
            const k = { triage: p.triage, verify: p.verify };
            const on = sameController(ctrl, k);
            return (
              <label key={p.name} className={`pick-card${on ? ' pick-on' : ''}`} title={`triage ${p.triage}, verify ${p.verify}`}>
                <input type="radio" name="setup" value={p.name} checked={on} onChange={() => pickCtrl(k)} />
                <span className="pick-name">
                  {friendlyConfig(p)}
                  {p.name === bestName && <span className="tag tag-best">Best</span>}
                </span>
                <span className="pick-desc">{configDescription(p)}</span>
                <span className="pick-stats num">
                  {cardStats(p.autoAcceptShare)}
                </span>
              </label>
            );
          })}
          {!preset && (
            <div className="pick-card pick-on pick-custom">
              <span className="pick-name">
                {friendlyModel(ctrl.triage)}
                {ctrl.triage !== ctrl.verify ? ` + ${friendlyModel(ctrl.verify)}` : ''}
              </span>
              <span className="pick-desc">{configDescription({ name: '', triage: ctrl.triage, verify: ctrl.verify })}</span>
              <span className="pick-stats muted">a combination the benchmark did not run; example rows only</span>
            </div>
          )}
        </fieldset>
        <p className="small muted">The figures on each card are from the benchmark’s test split.</p>
      </section>

      <section aria-labelledby="acc-h">
        <h2 id="acc-h">2. How accurate must the accepted answers be?</h2>
        <div className="card">
          <div className="slider big-slider">
            <label htmlFor="sl-target">
              Of the rows answered automatically, at least this share should be right
            </label>
            <div className="slider-row">
              <input
                id="sl-target"
                type="range"
                min={80}
                max={99}
                step={1}
                value={targetPct}
                aria-valuetext={`${targetPct} percent`}
                onChange={(e) => pickTarget(Number(e.target.value))}
              />
              <output htmlFor="sl-target" className="slider-value">
                {targetPct}%
              </output>
            </div>
          </div>
          <Why>
            Moving this refits the setup: for each step, it finds the lowest confidence at which the model’s answers are right at least this often on
            the example rows, and accepts answers at or above it. The benchmark used {Math.round(d.target * 100)}%.
          </Why>
        </div>
      </section>

      <section aria-labelledby="out-h">
        <h2 id="out-h">3. What happens to your rows</h2>
        <div className="card outcome">
          <Waffle counts={counts} sentenceId="outcome-sentence" />
          <div className="outcome-text">
            <p className="outcome-sentence" id="outcome-sentence" aria-live="polite">
              {outcomeSentence(now)}{' '}
              <span className="nowrap">
                Cost: {formatUsd(now.costPer1k.total)} per 1,000 rows
                <Star d={d} />.
              </span>
            </p>
            <ul className="legend waffle-legend" aria-hidden="true">
              <li>
                <Square state="right" /> {counts.right} answered automatically and right
              </li>
              <li>
                <Square state="wrong" /> {counts.wrong} answered automatically but wrong
              </li>
              <li>
                <Square state="check" /> {counts.check} sent to you to check
              </li>
            </ul>
            <div className="tiles tiles-outcome">
              <Tile label="Answered automatically" value={formatPct(now.acceptedShare, 1)} why="Rows where a model’s answer was confident enough to accept without a person looking at it." />
              <Tile
                label="Right, among those answered automatically"
                value={formatPct(now.precision, 1)}
                why="Of the rows answered automatically, the share whose answer matched the true label. This is what the slider above asks for."
              />
              <Tile label="Sent to you to check" value={formatPct(now.flaggedShare, 1)} why="Rows no step was confident about. They come to you with the stronger model’s best answer filled in." />
              <Tile
                label="Right overall, if you check nothing"
                value={formatPct(now.accuracyNoHuman, 1)}
                why="If you took every answer as is, including the ones sent to you, this share would be right."
              />
            </div>
            {base && (
              <p className="compare small">
                For comparison, {friendlyConfig(base, d.baselineModel)}: {Math.round((1 - base.precision) * 100)} of 100 wrong, none sent to you,{' '}
                {formatUsd(base.costPer1k.total)} per 1,000 rows
                <Star d={d} /> (test split).
              </p>
            )}
          </div>
        </div>
        <p className="small muted">Measured on {cal.rows.toLocaleString('en-US')} example rows that weren’t used for the results above.</p>
        <CostFootnote d={d} />
      </section>

      <details className="card advanced">
        <summary>Fine-tune each step (advanced)</summary>
        <p className="small muted">
          Each step accepts an answer when the model’s confidence is at or above its threshold; “never” switches a step off. The slider above fits all
          three; here you can move them one by one.
        </p>
        <div className="sliders">
          <Slider id="t0" label={`${STEP.triage} (${friendlyModel(ctrl.triage)}) accepts at or above`} value={t.t0} onChange={(v) => setManual({ ...t, t0: v })} />
          <Slider id="t1" label={`${STEP.verify1} (${friendlyModel(ctrl.verify)}) accepts at or above`} value={t.t1} onChange={(v) => setManual({ ...t, t1: v })} />
          <Slider id="t2" label={`${STEP.verify2} (${friendlyModel(ctrl.verify)}) accepts at or above`} value={t.t2} onChange={(v) => setManual({ ...t, t2: v })} />
        </div>
        <p>
          <button type="button" className="btn" onClick={() => setManual(null)} disabled={manual === null}>
            Back to the fitted thresholds
          </button>{' '}
          <span className="muted small num">
            fitted at {targetPct}%: {thresholdText(fitted.t0)} / {thresholdText(fitted.t1)} / {thresholdText(fitted.t2)}
            {preset && targetPct === Math.round(d.target * 100) ? ' (the thresholds the benchmark ran with)' : ''}
          </span>
        </p>
        <div className="controls">
          <label>
            Model for step 1
            <select value={ctrl.triage} onChange={(e) => pickCtrl({ ...ctrl, triage: e.target.value })}>
              {triageModels.map((m) => (
                <option key={m} value={m}>
                  {friendlyModel(m)} ({m})
                </option>
              ))}
            </select>
          </label>
          <label>
            Model for steps 2 and 3
            <select value={ctrl.verify} onChange={(e) => pickCtrl({ ...ctrl, verify: e.target.value })}>
              {verifyModels.map((m) => (
                <option key={m} value={m}>
                  {friendlyModel(m)} ({m})
                </option>
              ))}
            </select>
          </label>
        </div>
      </details>
    </>
  );
}

function Tile({ label, value, why }: { label: string; value: string; why: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      <Why>{why}</Why>
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

// ---------------------------------------------------------------- the waffle

type SquareState = 'right' | 'wrong' | 'check';

/** One square: filled for right, filled with a cross for wrong, outlined for "check" (shape as well as colour). */
function SquareMark({ x, y, s, state }: { x: number; y: number; s: number; state: SquareState }) {
  const r = s * 0.14;
  return (
    <g className={`sq sq-${state}`}>
      <rect x={x} y={y} width={s} height={s} rx={r} />
      {state === 'wrong' && (
        <path d={`M${x + s * 0.28} ${y + s * 0.28}L${x + s * 0.72} ${y + s * 0.72}M${x + s * 0.72} ${y + s * 0.28}L${x + s * 0.28} ${y + s * 0.72}`} className="cross" />
      )}
    </g>
  );
}

function Square({ state }: { state: SquareState }) {
  return (
    <svg width="14" height="14" viewBox="0 0 10 10" aria-hidden="true" className="waffle">
      <SquareMark x={0.5} y={0.5} s={9} state={state} />
    </svg>
  );
}

function Waffle({ counts, sentenceId }: { counts: { right: number; wrong: number; check: number }; sentenceId: string }) {
  const cells: SquareState[] = [
    ...Array.from({ length: counts.right }, () => 'right' as const),
    ...Array.from({ length: counts.wrong }, () => 'wrong' as const),
    ...Array.from({ length: counts.check }, () => 'check' as const),
  ];
  return (
    <svg viewBox="0 0 100 100" className="waffle waffle-main" role="img" aria-labelledby={sentenceId}>
      {cells.map((state, i) => (
        <SquareMark key={i} x={(i % 10) * 10 + 1} y={Math.floor(i / 10) * 10 + 1} s={8} state={state} />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------- 2. Results

function Results({ d }: { d: ExploreResponse }) {
  const ours = d.results.configs.filter((c) => c.triage && c.verify);
  const base = baselineOf(d);
  const best = bestConfig(d.results.configs, d.target);
  const testRows = ours[0]?.rows ?? 0;
  return (
    <>
      <section aria-labelledby="results-h">
        <h2 id="results-h">Results on the test split</h2>
        <p className="muted">
          Every setup ran on the same {testRows.toLocaleString('en-US')} rows it had never seen, with the thresholds fitted for{' '}
          {Math.round(d.target * 100)}% accuracy among the automatically answered rows.
          {base && base.rows !== testRows ? ` The comparison ran on a ${base.rows.toLocaleString('en-US')}-row sample of them.` : ''}
        </p>
        <div className="card flush table-wrap">
          <table className="data results">
            <caption className="sr-only">Results on the test split, one row per setup, the comparison last</caption>
            <thead>
              <tr>
                <th scope="col">Setup</th>
                <th scope="col" className="num">Answered automatically</th>
                <th scope="col" className="num">Right, among those</th>
                <th scope="col" className="num">Sent to you to check</th>
                <th scope="col" className="num">Right overall, if you check nothing</th>
                <th scope="col" className="num">
                  Cost per 1,000 rows
                  <Star d={d} />
                </th>
              </tr>
            </thead>
            <tbody>
              {ours.map((c) => (
                <tr key={c.name} className={c.name === best ? 'best' : undefined}>
                  <th scope="row">
                    <span title={`triage ${c.triage}, verify ${c.verify}`}>{friendlyConfig(c)}</span>
                    {c.name === best && <span className="tag tag-best">Best</span>}
                    <span className="small muted block">{configDescription(c)}</span>
                  </th>
                  <td className="num">{formatPct(c.autoAcceptShare, 1)}</td>
                  <td className="num">{formatPct(c.precision, 1)}</td>
                  <td className="num">{formatPct(c.flaggedShare, 1)}</td>
                  <td className="num">{formatPct(c.accuracyNoHuman, 1)}</td>
                  <td className="num">{formatUsd(c.costPer1k.total)}</td>
                </tr>
              ))}
              {base && (
                <tr className="baseline-row">
                  <th scope="row">
                    <span title={d.baselineModel ?? 'baseline'}>{friendlyConfig(base, d.baselineModel)}</span>
                    <span className="small muted block">For comparison: {configDescription(base, d.baselineModel).toLowerCase()}</span>
                  </th>
                  <td className="num">{formatPct(base.autoAcceptShare, 1)}</td>
                  <td className="num">{formatPct(base.precision, 1)}</td>
                  <td className="num">{formatPct(base.flaggedShare, 1)}</td>
                  <td className="num">{formatPct(base.accuracyNoHuman, 1)}</td>
                  <td className="num">{formatUsd(base.costPer1k.total)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          “Best” is the setup that answers the most rows automatically while staying at or above the {Math.round(d.target * 100)}% target.
        </p>
        <div className="glossary">
          <Why label="What does “answered automatically” mean?">A model’s answer was confident enough to accept without a person looking at it.</Why>
          <Why label="What does “right, among those” mean?">Of the automatically answered rows, the share whose answer matched the true label.</Why>
          <Why label="What does “sent to you to check” mean?">No step was confident enough; the row comes to you with the stronger model’s best answer filled in.</Why>
          <Why label="What does “right overall, if you check nothing” mean?">If you took every answer as is, including the rows sent to you, this share would be right.</Why>
        </div>
        <CostFootnote d={d} />
      </section>
      <section aria-labelledby="cost-h">
        <h2 id="cost-h">Where the money goes</h2>
        <CostBars configs={[...ours, ...(base ? [base] : [])]} baseline={base?.name ?? null} d={d} />
      </section>
    </>
  );
}

function CostBars({ configs, baseline, d }: { configs: ExploreConfigResult[]; baseline: string | null; d: ExploreResponse }) {
  const rowH = 36;
  const left = 150;
  const right = 64;
  const W = 760;
  const sep = 14;
  const H = configs.length * rowH + 12 + (baseline ? sep : 0);
  const max = Math.max(...configs.map((c) => stageTotal(c.costPer1k)), 1e-9);
  const plotW = W - left - right;
  const summary = configs.map((c) => `${friendlyConfig(c, d.baselineModel)} ${formatUsd(c.costPer1k.total)}`).join(', ');
  return (
    <figure className="card viz">
      <figcaption className="card-title">
        Cost per 1,000 rows, by step
        <Star d={d} />
      </figcaption>
      <Legend box items={STAGES.map((s, i) => ({ label: STEP[s], slot: i + 1 }))} />
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Stacked bars of cost per 1,000 rows by step. ${summary}. A table follows.`} className="chart">
        {configs.map((c, row) => {
          const isBase = c.name === baseline;
          const y = 6 + row * rowH + (isBase ? sep : 0);
          let x = left;
          return (
            <g key={c.name}>
              {isBase && <line x1={left} x2={W - right} y1={y - sep / 2} y2={y - sep / 2} className="grid" />}
              <text x={left - 8} y={y + 15} textAnchor="end" className="ax">
                {friendlyConfig(c, d.baselineModel)}
              </text>
              {STAGES.map((s, i) => {
                const v = c.costPer1k[s];
                if (v <= 0) return null;
                const w = (v / max) * plotW;
                const x0 = x;
                x += w;
                return (
                  <rect key={s} x={x0} y={y} width={Math.max(w - 2, 1)} height={22} rx={2} className={`s${i + 1}`}>
                    <title>{`${friendlyConfig(c, d.baselineModel)}, ${STEP[s]}: ${formatUsd(v)} per 1,000 rows`}</title>
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
                <th scope="col">Setup</th>
                {STAGES.map((s) => (
                  <th key={s} scope="col" className="num">
                    {STEP[s]}
                  </th>
                ))}
                <th scope="col" className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {configs.map((c) => (
                <tr key={c.name} className={c.name === baseline ? 'baseline-row' : undefined}>
                  <th scope="row">{friendlyConfig(c, d.baselineModel)}</th>
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

// ---------------------------------------------------------------- 3. How it was tested

function Method({ d }: { d: ExploreResponse }) {
  const cal = d.calibration;
  const testRows = d.results.configs.find((c) => c.triage)?.rows ?? 0;
  return (
    <>
      <section aria-labelledby="method-h">
        <h2 id="method-h">Method</h2>
        <p>
          Each setup has a <strong>decision model</strong> that gives a probability with every answer. A cheap model answers first (
          {STEP.triage.toLowerCase()}); if it is not confident enough, a cheap writer model answers and the decision model checks it (step 2); if that
          is still not confident enough, a stronger writer answers and is checked again (step 3); what is left is sent to you.
        </p>
        <p>
          The confidence needed at each step, the <strong>threshold</strong>, was fitted on{' '}
          {cal ? `${cal.rows.toLocaleString('en-US')} example rows` : 'held-out example rows'} that the results never touch: the lowest cut that keeps
          at least {Math.round(d.target * 100)}% of the accepted answers right (the <strong>target precision</strong>) while accepting as many rows as
          possible. The results on the Results tab apply those thresholds, unchanged, to {testRows.toLocaleString('en-US')} test rows. The “Try it” tab
          refits them live on the example rows when you move the accuracy slider.
          {cal ? ` (Example rows: run ${cal.runId}.)` : ''}
        </p>
        <p className="small">
          More in the <a href="https://github.com/Rubick1997/twopass#readme">README</a>.
        </p>
      </section>

      <section aria-labelledby="cov-h">
        <h2 id="cov-h">More automatic vs more accurate</h2>
        <p className="muted">
          Every setup can trade the two: accept at a lower confidence and more rows are answered automatically, but fewer of them are right. The curve
          sweeps one confidence cut from 0.50 to 1.00 across all three steps, on the example rows.
        </p>
        {cal ? <CoverageChart d={d} /> : <p className="note note-warn">Not available: {d.calibrationMissingReason ?? 'the calibration run is missing'}.</p>}
      </section>

      <section aria-labelledby="rel-h">
        <h2 id="rel-h">Does the model’s confidence mean what it says?</h2>
        <p className="muted">
          A model that says “90% sure” should be right about 90% of the time. Each small chart puts the model’s stated probability on the horizontal
          axis and how often it was actually right on the vertical one, on the test rows, in bins; points on the dotted diagonal are honest. The{' '}
          <strong>ECE</strong> (expected calibration error) sums those gaps, weighted by how many rows fall in each bin: 0 is perfect. “Calibrated”
          shows the same after an <strong>isotonic fit</strong> on the example rows, a monotone correction of the probabilities measured out of sample,
          which is what makes the thresholds trustworthy.
        </p>
        <Reliability items={d.reliability} configs={d.results.configs} />
      </section>
    </>
  );
}

function CoverageChart({ d }: { d: ExploreResponse }) {
  const cal = d.calibration!;
  const rows = cal.data;
  const lines = useMemo(() => {
    const out: Array<{ name: string; ctrl: Controller; curve: CurvePoint[]; calibrated: Thresholds | null }> = [];
    const ks = controllersFor(rows, cal.models);
    for (const c of d.results.configs) {
      if (!c.triage || !c.verify) continue;
      const k = { triage: c.triage, verify: c.verify };
      if (!ks.some((x) => sameController(x, k))) continue;
      out.push({ name: friendlyConfig(c), ctrl: k, curve: coverageCurve(rows, k), calibrated: c.thresholds });
    }
    return out.slice(0, MAX_LINES);
  }, [d, rows, cal.models]);

  const W = 720;
  const H = 380;
  const m = { l: 56, r: 24, t: 16, b: 48 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const prec = lines.flatMap((l) => l.curve.map((p) => p.precision)).filter((p): p is number => p !== null);
  const yMin = Math.max(0, Math.floor((Math.min(...prec, d.target) - 0.02) * 20) / 20);
  const X = (s: number) => m.l + s * pw;
  const Y = (p: number) => m.t + (1 - (p - yMin) / (1 - yMin)) * ph;
  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + ((1 - yMin) * i) / 4);
  const marks = lines.flatMap((l) => {
    if (!l.calibrated) return [];
    const r = replay(rows, l.ctrl, l.calibrated);
    return r.precision === null ? [] : [{ name: l.name, r: r as ReplayResult & { precision: number } }];
  });

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
      : lines.map((l) => {
          const p = nearest(l.curve, cursor);
          return `${l.name}: ${formatPct(p?.acceptedShare, 1)} answered automatically, ${formatPct(p?.precision, 1)} right, at confidence ${p?.t.toFixed(2)}`;
        });

  const summary = lines
    .map((l) => {
      const hi = l.curve[0];
      const lo = l.curve[l.curve.length - 1];
      return `${l.name}: from ${formatPct(hi?.acceptedShare)} answered automatically with ${formatPct(hi?.precision)} right (cut 0.50) to ${formatPct(lo?.acceptedShare)} with ${formatPct(lo?.precision)} right (cut 1.00)`;
    })
    .join('; ');

  return (
    <figure className="card viz">
      <figcaption className="card-title">Share answered automatically against the share of those that are right, per setup</figcaption>
      <Legend items={[...lines.map((l, i) => ({ label: l.name, slot: i + 1 })), { label: `target ${formatPct(d.target)}`, slot: 0, dashed: true }]} />
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart"
        role="img"
        aria-label={`Line chart, share answered automatically on x, share right among those on y. ${summary}. Target ${formatPct(d.target)}. Arrow keys move a readout; a table view is below.`}
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
          Answered automatically
        </text>
        <text transform={`translate(14 ${m.t + ph / 2}) rotate(-90)`} textAnchor="middle" className="ax">
          Right, among those
        </text>
        <line x1={m.l} x2={W - m.r} y1={Y(d.target)} y2={Y(d.target)} className="target" />
        <text x={W - m.r - 4} y={Y(d.target) - 5} textAnchor="end" className="ax">
          target {formatPct(d.target)}
        </text>
        {lines.map((l, i) => (
          <path key={l.name} d={path(l.curve, X, Y)} className={`line s${i + 1}`} />
        ))}
        {cursor !== null && <line x1={X(cursor)} x2={X(cursor)} y1={m.t} y2={m.t + ph} className="cursor" />}
        {marks.map((mk) => (
          <rect
            key={mk.name}
            x={X(mk.r.acceptedShare) - 6}
            y={Y(mk.r.precision) - 6}
            width={12}
            height={12}
            className="mark-cal"
            transform={`rotate(45 ${X(mk.r.acceptedShare)} ${Y(mk.r.precision)})`}
          >
            <title>{`${mk.name} as the benchmark ran it: ${formatPct(mk.r.acceptedShare, 1)} answered automatically, ${formatPct(mk.r.precision, 1)} right`}</title>
          </rect>
        ))}
      </svg>
      <p className="small chart-key">
        <span aria-hidden="true">◇</span> where each setup sits with the thresholds the benchmark ran with. The vertical value is undefined where
        nothing is accepted.
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
                <th scope="col">Confidence cut</th>
                {lines.map((l) => (
                  <th key={l.name} scope="col" className="num">
                    {l.name}: answered automatically / right
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 11 }, (_, i) => i * 5).map((i) => (
                <tr key={i}>
                  <th scope="row">{(0.5 + i / 100).toFixed(2)}</th>
                  {lines.map((l) => {
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

// ---------------------------------------------------------------- reliability

function Reliability({ items, configs }: { items: ExploreReliability[]; configs: ExploreConfigResult[] }) {
  if (!items.length) return <p className="muted">No reliability data in bench-report.json.</p>;
  return (
    <>
      <ul className="legend">
        <li>
          <svg width="22" height="10" aria-hidden="true">
            <circle cx="11" cy="5" r="4" className="dot-raw" />
          </svg>
          as the model said it (raw)
        </li>
        <li>
          <svg width="22" height="10" aria-hidden="true">
            <circle cx="11" cy="5" r="4" className="dot-cal" />
          </svg>
          after the isotonic fit (calibrated)
        </li>
      </ul>
      <div className="rel-grid">
        {items.map((r) => (
          <ReliabilityChart key={`${r.config}/${r.stage}`} r={r} setup={friendlyConfig(configs.find((c) => c.name === r.config) ?? { name: r.config, triage: null, verify: null })} />
        ))}
      </div>
    </>
  );
}

function ReliabilityChart({ r, setup }: { r: ExploreReliability; setup: string }) {
  const S = 180;
  const m = 28;
  const P = S - m - 8;
  const X = (v: number) => m + v * P;
  const Y = (v: number) => 8 + (1 - v) * P;
  const raw = r.raw.filter((b) => b.n > 0);
  const cal = r.calibrated.filter((b) => b.n > 0);
  const title = `${setup} setup · ${STEP[r.stage]}`;
  const caption = `ECE ${r.eceRaw.toFixed(3)} → ${r.eceCalibrated.toFixed(3)}, ${r.n.toLocaleString('en-US')} rows`;
  return (
    <figure className="rel">
      <figcaption>
        <strong title={`${r.config} · ${r.stage} (${r.model})`}>{title}</strong>
        <br />
        <span className="muted small">
          {friendlyModel(r.model)} deciding · {caption}
        </span>
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
            <title>{`raw ${b.lo.toFixed(1)}–${b.hi.toFixed(1)}: said ${b.meanP.toFixed(2)}, right ${b.accuracy.toFixed(2)}, ${b.n} rows`}</title>
          </circle>
        ))}
        {cal.map((b) => (
          <circle key={`c${b.lo}`} cx={X(b.meanP)} cy={Y(b.accuracy)} r={4} className="dot-cal">
            <title>{`calibrated ${b.lo.toFixed(1)}–${b.hi.toFixed(1)}: said ${b.meanP.toFixed(2)}, right ${b.accuracy.toFixed(2)}, ${b.n} rows`}</title>
          </circle>
        ))}
      </svg>
      <div className="sr-only">
        <table>
          <caption>{`${title}: ${caption}`}</caption>
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Bin</th>
              <th scope="col">Rows</th>
              <th scope="col">Mean probability</th>
              <th scope="col">Share right</th>
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
      </div>
    </figure>
  );
}

function bins(bs: Array<{ meanP: number; accuracy: number }>, X: (v: number) => number, Y: (v: number) => number): string {
  return bs.map((b, i) => `${i ? 'L' : 'M'}${X(b.meanP).toFixed(1)} ${Y(b.accuracy).toFixed(1)}`).join('');
}
