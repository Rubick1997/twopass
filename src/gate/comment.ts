import type { Comparison } from './compare.ts';
import type { GateId, GateOutcome } from './gates.ts';
import { noiseAllowances } from './gates.ts';
import type { NoiseFile } from './noise.ts';
import type { RecalibrationProposal } from './recalibrate.ts';
import type { GateResult } from './result.ts';
import type { ReviewRow } from './review.ts';
import { labelLimit } from './noise.ts';
import { pct } from './stats.ts';

// The sticky PR comment. Pure: inputs in, markdown out. The marker lets CI find and update its own comment.

export const commentMarker = (task: string): string => `<!-- twopass-eval-gate:${task} -->`;

export interface CommentInput {
  comparison: Comparison;
  gates: Record<GateId, GateOutcome>;
  enforce: GateId;
  noise: NoiseFile | undefined;
  proposal: RecalibrationProposal | undefined;
  review: ReviewRow[];
  base: GateResult;
  head: GateResult;
  taskPath: string;
  headPath: string;
}

const ok = (b: boolean) => (b ? '✅' : '❌');
const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;
const usd = (x: number) => `$${x.toFixed(x < 1 ? 3 : 2)}`;
const short = (x: number) => (x >= 1.005 ? 'never' : x.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''));
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function renderComment(i: CommentInput): string {
  const { comparison: c, gates } = i;
  const g3 = gates.g3;
  const enforced = gates[i.enforce];
  const allow = noiseAllowances(i.noise);
  const promiseReason = g3.reasons.find((r) => r.check === 'promise')!;
  const out: string[] = [commentMarker(c.task)];

  out.push(`## ${ok(enforced.pass)} Eval gate: ${c.task}`);
  out.push(
    `**Auto-accepted rows ≥${pct(c.promise, 0)} right: lower bound ${pct(c.head.acceptedPrecision.lower)} ${ok(promiseReason.pass)}**` +
      (i.enforce === 'g3' ? '' : ` · enforced gate: ${enforced.name} ${ok(enforced.pass)}`),
  );
  if (!enforced.pass) {
    const failed = enforced.reasons.filter((r) => !r.pass).map((r) => `**${r.check}**: ${r.detail}`);
    out.push('', `Blocked by ${enforced.name}:`, ...failed.map((f) => `- ${f}`));
  }
  const others = (['g1', 'g2', 'g3'] as const).filter((g) => g !== i.enforce);
  out.push('', `What the other gates would say: ${others.map((g) => `${gates[g].name} ${ok(gates[g].pass)}`).join(' · ')}`);
  if (!c.routing.same) out.push('', `⚠️ Base and head used different routing; the comparison mixes providers.\n- base: \`${c.routing.base}\`\n- head: \`${c.routing.head}\``);
  if (!i.noise) out.push('', '⚠️ No noise file: limits assume unchanged main never moves. Run `twopass gate noise` on unchanged main.');
  if (c.onlyBase.length || c.onlyHead.length) out.push('', `Rows only in base: ${c.onlyBase.length}, only in head: ${c.onlyHead.length} (left out of the comparison).`);

  // Guardrails
  const broken = c.labels.filter((l) => l.netLoss > labelLimit(i.noise, l.label));
  out.push(
    '',
    '### Guardrails (block)',
    '',
    '| | base | head | limit | |',
    '|---|---:|---:|---|:-:|',
    `| Auto-accepted rows right (Wilson lower bound) | ${pct(c.base.acceptedPrecision.lower)} | ${pct(c.head.acceptedPrecision.lower)} | ≥ ${pct(c.promise, 0)}${allow.acceptedLower ? ` − ${(100 * allow.acceptedLower).toFixed(1)} pts noise` : ''} | ${ok(promiseReason.pass)} |`,
    `| Labels losing rows beyond noise | | ${broken.length ? broken.map((l) => `${cell(l.label)} −${l.netLoss}`).join(', ') : 'none'} | per label, min 2 | ${ok(!broken.length)} |`,
    `| Auto-accepted but wrong | ${c.base.confidentWrong} | ${c.head.confidentWrong} | +${allow.confidentWrong} | ${ok(g3.reasons.find((r) => r.check === 'confident-wrong')!.pass)} |`,
  );

  // North Stars
  out.push(
    '',
    '### North Stars (reported, never block)',
    '',
    '| | base | head |',
    '|---|---:|---:|',
    `| Auto-accepted | ${pct(c.base.acceptShare)} | ${pct(c.head.acceptShare)} |`,
    `| Sent to a person | ${pct(c.base.sentToPersonShare)} | ${pct(c.head.sentToPersonShare)} |`,
    `| Accuracy, all rows | ${pct(c.base.accuracy)} | ${pct(c.head.accuracy)} |`,
    `| Auto-accepted rows right | ${pct(c.base.acceptedPrecision.point)} | ${pct(c.head.acceptedPrecision.point)} |`,
    `| Cost per 1,000 rows (list price) | ${usd(c.base.costPer1k)} | ${usd(c.head.costPer1k)} |`,
  );

  // Recalibration
  if (i.proposal && !promiseReason.pass) out.push('', ...renderProposal(i.proposal, i.taskPath, i.headPath));

  // Rows to read
  if (i.review.length) {
    out.push(
      '',
      `<details><summary><b>Rows to read (${i.review.length})</b>: changed between base and head, the riskiest auto-accepted first</summary>`,
      '',
      '| # | text | base | head | head status | confidence |',
      '|---:|---|---|---|---|---:|',
      ...i.review.map(
        (r, n) =>
          `| ${n + 1} | ${cell(clip(r.text))} | ${cell(r.baseAnswer || '–')} | ${cell(r.headAnswer || '–')} | ${r.headStatus}${r.why.includes('newly') ? ' (new)' : ''} | ${r.confidence === null ? '–' : r.confidence.toFixed(2)} |`,
      ),
      '',
      'Gold labels are not shown: these are the rows worth a human look.',
      '</details>',
    );
  }

  // Largest label changes
  const moved = [...c.labels].sort((a, b) => Math.abs(b.headAccuracy - b.baseAccuracy) - Math.abs(a.headAccuracy - a.baseAccuracy) || b.netLoss - a.netLoss).slice(0, 5).filter((l) => l.rightToWrong + l.wrongToRight > 0);
  if (moved.length) {
    out.push(
      '',
      '<details><summary>Labels that moved most</summary>',
      '',
      '| label | rows | base | head | right→wrong | wrong→right |',
      '|---|---:|---:|---:|---:|---:|',
      ...moved.map((l) => `| ${cell(l.label)} | ${l.n} | ${pct(l.baseAccuracy, 0)} | ${pct(l.headAccuracy, 0)} | ${l.rightToWrong} | ${l.wrongToRight} |`),
      '</details>',
    );
  }

  // This run
  const providers = (r: GateResult) =>
    Object.entries(r.cost.byProvider ?? {})
      .map(([p, v]) => `${p} ${usd(v.listUsd)}${v.cacheRead ? ` (cache read ${v.cacheRead.toLocaleString('en-US')} tok)` : ''}`)
      .join(', ');
  out.push(
    '',
    '<details><summary>This run: cost, time, routing</summary>',
    '',
    `- Rows: ${c.pairs.length} paired. Answer flips: ${c.answerFlips} (right→wrong ${c.rightToWrong}, wrong→right ${c.wrongToRight})${i.noise ? `; unchanged main flips up to ${i.noise.maxAnswerFlips}` : ''}.`,
    `- Cost (list price): base ${usd(i.base.cost.listUsd)} [${providers(i.base)}], head ${usd(i.head.cost.listUsd)} [${providers(i.head)}]. Runtime: ${i.base.runtimeSec}s + ${i.head.runtimeSec}s.`,
    `- Thresholds: base t0 ${short(i.base.thresholds.t0)} / t1 ${short(i.base.thresholds.t1)} / t2 ${short(i.base.thresholds.t2)}; head t0 ${short(i.head.thresholds.t0)} / t1 ${short(i.head.thresholds.t1)} / t2 ${short(i.head.thresholds.t2)}.`,
    `- Routing: \`${c.routing.head}\``,
    `- Served: ${i.head.servedModels.map((m) => `\`${m}\``).join(', ')}`,
    `- Refs: base \`${c.refs.base}\`${i.base.gitSha ? ` (${i.base.gitSha.slice(0, 7)})` : ''}, head \`${c.refs.head}\`${i.head.gitSha ? ` (${i.head.gitSha.slice(0, 7)})` : ''}`,
    '</details>',
  );
  return out.join('\n') + '\n';
}

export function renderProposal(p: RecalibrationProposal, taskPath: string, headPath: string): string[] {
  const out = ['### Recalibration proposal'];
  if (p.kind === 'needs-points') {
    out.push('', `Can't propose thresholds yet: ${p.reason}`, '', `\`${p.command}\``);
    return out;
  }
  if (p.kind === 'cannot-restore') {
    out.push('', `**No threshold restores the promise.** ${p.reason}`);
    return out;
  }
  const t = (x: { t0: number; t1: number; t2: number }) => `t0 ${short(x.t0)}, t1 ${short(x.t1)}, t2 ${short(x.t2)}`;
  const line = p.restores
    ? `**The promise holds again on held-out calibration rows; auto-accept goes from ${pct(p.checkCurrent.acceptShare, 0)} to ${pct(p.checkProposed.acceptShare, 0)}.**`
    : `**These thresholds don't restore the promise.** ${p.note ?? ''}`;
  out.push(
    '',
    line,
    '',
    `| on ${p.checkRows} held-out calibration rows | current (${t(p.current)}) | proposed (${t(p.proposed)}) |`,
    '|---|---:|---:|',
    `| Auto-accepted | ${pct(p.checkCurrent.acceptShare)} (${p.checkCurrent.accepted}) | ${pct(p.checkProposed.acceptShare)} (${p.checkProposed.accepted}) |`,
    `| Auto-accepted rows right | ${pct(p.checkCurrent.precision.point)} | ${pct(p.checkProposed.precision.point)} |`,
    `| Wilson 95% lower bound | ${pct(p.checkCurrent.precision.lower)} | ${pct(p.checkProposed.precision.lower)} |`,
    '',
    `Fitted on ${p.fitRows} calibration rows for ${p.checker.triage === p.checker.verify ? p.checker.verify : `${p.checker.triage} / ${p.checker.verify}`} at ${pct(p.target, 0)}; never on this PR's rows. ` +
      `The lower bound on ${p.checkRows} rows is wide; the point estimate is what the fit targets.`,
  );
  if (p.checkTooSmall) {
    out.push('', `⚠️ Only ${p.checkProposed.accepted} held-out rows were auto-accepted: treat the check as a sanity check, not evidence. More calibration rows make it meaningful.`);
  }
  if (p.restores) {
    out.push('', 'To apply it, commit the new thresholds (that commit goes through this gate too):', '', `\`twopass gate recalibrate --task ${taskPath} --run ${headPath} --write\``);
  }
  return out;
}
