import type { Bin } from '../calibrate.ts';
import type { CheckerResult } from './report.ts';

// Reliability plot for the extract report: one panel per checker, test split. Pure string building, no dependencies.

const RAW = '#1f5fbf';
const CAL = '#d9822b';
const INK = '#333333';
const GRID = '#d0d0d0';
const FONT = 'font-family="Helvetica, Arial, sans-serif"';

const PANEL = 280;
const PLOT = 200;
const WIDTH = 900;
const COLS = 3;
const ROW_H = 340;
const HEAD = 56;

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const f2 = (x: number) => x.toFixed(2);
const e3 = (x: number | null) => (x === null ? '–' : x.toFixed(3));

function panel(c: CheckerResult, x0: number, y0: number): string {
  const left = x0 + 44;
  const top = y0 + 52;
  const px = (v: number) => left + v * PLOT;
  const py = (v: number) => top + (1 - v) * PLOT;
  const out: string[] = [];
  out.push(`<text x="${x0 + 10}" y="${y0 + 18}" ${FONT} font-size="14" font-weight="bold" fill="${INK}">${escapeXml(c.model)}</text>`);
  const sub = `ECE raw ${e3(c.reliability.eceRaw)}${c.reliability.eceCalibrated === null ? '' : `, calibrated ${e3(c.reliability.eceCalibrated)}`}`;
  out.push(`<text x="${x0 + 10}" y="${y0 + 34}" ${FONT} font-size="11" fill="${INK}">${escapeXml(sub)}</text>`);
  for (const t of [0, 0.5, 1]) {
    out.push(`<line x1="${px(0)}" y1="${py(t)}" x2="${px(1)}" y2="${py(t)}" stroke="${GRID}" stroke-width="0.5"/>`);
    out.push(`<line x1="${px(t)}" y1="${py(0)}" x2="${px(t)}" y2="${py(1)}" stroke="${GRID}" stroke-width="0.5"/>`);
    out.push(`<text x="${px(t)}" y="${py(0) + 14}" ${FONT} font-size="10" text-anchor="middle" fill="${INK}">${t}</text>`);
    out.push(`<text x="${px(0) - 6}" y="${py(t) + 3}" ${FONT} font-size="10" text-anchor="end" fill="${INK}">${t}</text>`);
  }
  out.push(`<rect x="${px(0)}" y="${py(1)}" width="${PLOT}" height="${PLOT}" fill="none" stroke="${INK}" stroke-width="1"/>`);
  out.push(`<line x1="${px(0)}" y1="${py(0)}" x2="${px(1)}" y2="${py(1)}" stroke="#888888" stroke-width="1" stroke-dasharray="4 3"/>`);
  out.push(`<text x="${px(0.5)}" y="${py(0) + 28}" ${FONT} font-size="10" text-anchor="middle" fill="${INK}">mean predicted p</text>`);
  out.push(`<text transform="translate(${x0 + 10} ${py(0.5)}) rotate(-90)" ${FONT} font-size="10" text-anchor="middle" fill="${INK}">share right</text>`);
  const series = (bins: Bin[], colour: string) => {
    const pts = bins.filter((b) => b.n > 0);
    const maxN = Math.max(...pts.map((b) => b.n), 1);
    if (pts.length > 1) out.push(`<polyline points="${pts.map((b) => `${f2(px(b.meanP))},${f2(py(b.accuracy))}`).join(' ')}" fill="none" stroke="${colour}" stroke-width="1.5"/>`);
    for (const b of pts) {
      const r = 2 + 6 * Math.sqrt(b.n / maxN);
      out.push(`<circle cx="${f2(px(b.meanP))}" cy="${f2(py(b.accuracy))}" r="${f2(r)}" fill="${colour}" fill-opacity="0.6" stroke="${colour}"/>`);
    }
  };
  series(c.reliability.raw, RAW);
  if (c.reliability.calibrated) series(c.reliability.calibrated, CAL);
  return `<g>${out.join('')}</g>`;
}

/** Self-contained SVG with one reliability panel per checker, for the checkers that have data. */
export function reliabilitySvg(checkers: CheckerResult[]): string {
  const n = Math.max(checkers.length, 1);
  const cols = Math.min(n, COLS);
  const rows = Math.ceil(n / cols);
  const height = HEAD + rows * ROW_H;
  const cw = WIDTH / cols;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}">`);
  parts.push(`<rect width="${WIDTH}" height="${height}" fill="#ffffff"/>`);
  parts.push(`<text x="16" y="22" ${FONT} font-size="15" font-weight="bold" fill="${INK}">Checker reliability, round 1, test split</text>`);
  parts.push(`<circle cx="22" cy="40" r="5" fill="${RAW}" fill-opacity="0.6" stroke="${RAW}"/><text x="32" y="44" ${FONT} font-size="11" fill="${INK}">raw p(supported)</text>`);
  parts.push(`<circle cx="152" cy="40" r="5" fill="${CAL}" fill-opacity="0.6" stroke="${CAL}"/><text x="162" y="44" ${FONT} font-size="11" fill="${INK}">calibrated (isotonic, fitted on calibration split)</text>`);
  parts.push(`<line x1="440" y1="40" x2="466" y2="40" stroke="#888888" stroke-dasharray="4 3"/><text x="472" y="44" ${FONT} font-size="11" fill="${INK}">perfectly calibrated</text>`);
  parts.push(`<text x="884" y="22" text-anchor="end" ${FONT} font-size="11" fill="${INK}">circle area grows with the number of fields in the bin</text>`);
  checkers.forEach((c, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    parts.push(panel(c, col * cw + (cw - PANEL) / 2, HEAD + row * ROW_H));
  });
  parts.push('</svg>');
  return parts.join('\n') + '\n';
}
