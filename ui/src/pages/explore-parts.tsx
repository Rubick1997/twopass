import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { exploreHref } from '../hooks.ts';

// Pieces shared by the two explorers (closed-choice benches and extraction benches).

export interface ReliabilityBin {
  lo: number;
  hi: number;
  n: number;
  meanP: number;
  accuracy: number;
}

export interface ReliabilityData {
  n: number;
  eceRaw: number;
  /** null: no calibrated version (the checker has no isotonic fit). */
  eceCalibrated: number | null;
  raw: ReliabilityBin[];
  calibrated: ReliabilityBin[] | null;
  /** What a bin counts. Default "rows". */
  unit?: 'rows' | 'fields';
}

/** A one-sentence explanation behind a disclosure, never a hover tooltip. */
export function Why({ children, label = 'What does this mean?' }: { children: ReactNode; label?: string }) {
  return (
    <details className="why">
      <summary>{label}</summary>
      <p>{children}</p>
    </details>
  );
}

export function Tile({ label, value, why }: { label: string; value: string; why: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      <Why>{why}</Why>
    </div>
  );
}

export type SquareState = 'right' | 'wrong' | 'check';

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

export function Square({ state }: { state: SquareState }) {
  return (
    <svg width="14" height="14" viewBox="0 0 10 10" aria-hidden="true" className="waffle">
      <SquareMark x={0.5} y={0.5} s={9} state={state} />
    </svg>
  );
}

export function Waffle({ counts, sentenceId }: { counts: { right: number; wrong: number; check: number }; sentenceId: string }) {
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

export function ReliabilityChart({ r, title, subtitle, tooltip }: { r: ReliabilityData; title: string; subtitle: string; tooltip?: string }) {
  const S = 180;
  const m = 28;
  const P = S - m - 8;
  const X = (v: number) => m + v * P;
  const Y = (v: number) => 8 + (1 - v) * P;
  const raw = r.raw.filter((b) => b.n > 0);
  const cal = (r.calibrated ?? []).filter((b) => b.n > 0);
  const caption = `ECE ${r.eceRaw.toFixed(3)}${r.eceCalibrated === null ? '' : ` → ${r.eceCalibrated.toFixed(3)}`}, ${r.n.toLocaleString('en-US')} ${r.unit ?? 'rows'}`;
  return (
    <figure className="rel">
      <figcaption>
        <strong title={tooltip}>{title}</strong>
        <br />
        <span className="muted small">
          {subtitle} · {caption}
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
            <title>{`raw ${b.lo.toFixed(1)}–${b.hi.toFixed(1)}: said ${b.meanP.toFixed(2)}, right ${b.accuracy.toFixed(2)}, ${b.n} ${r.unit ?? 'rows'}`}</title>
          </circle>
        ))}
        {cal.map((b) => (
          <circle key={`c${b.lo}`} cx={X(b.meanP)} cy={Y(b.accuracy)} r={4} className="dot-cal">
            <title>{`calibrated ${b.lo.toFixed(1)}–${b.hi.toFixed(1)}: said ${b.meanP.toFixed(2)}, right ${b.accuracy.toFixed(2)}, ${b.n} ${r.unit ?? 'rows'}`}</title>
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
              <th scope="col">{r.unit === 'fields' ? 'Fields' : 'Rows'}</th>
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

// ---------------------------------------------------------------- tabs

export const TABS = [
  { key: 'try', label: 'Try it' },
  { key: 'results', label: 'Results' },
  { key: 'method', label: 'How it was tested' },
] as const;
export type TabKey = (typeof TABS)[number]['key'];
export const isTab = (x: string | undefined): x is TabKey => TABS.some((t) => t.key === x);

/** The tablist (arrow keys, tab in the URL hash) and one panel per tab. */
export function TabbedPanels({ benchId, tab, panels }: { benchId: string; tab: TabKey; panels: Record<TabKey, ReactNode> }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const go = (key: TabKey) => {
    window.location.hash = exploreHref(benchId, key);
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
      {TABS.map((t) => (
        <div key={t.key} role="tabpanel" id={`panel-${t.key}`} aria-labelledby={`tab-${t.key}`} hidden={tab !== t.key} className="panel">
          {panels[t.key]}
        </div>
      ))}
    </>
  );
}
