import { useMemo, useState, type ReactNode } from 'react';
import type { ExtractConfigMetrics, ExtractExploreResponse, ExtractSlotMetrics } from '../../../src/ui/api-types.ts';
import { friendlyModel, waffleCounts } from '../explore.ts';
import { replayExtract, type Pipeline } from '../explore-extract.ts';
import { formatPct, formatUsd, thresholdText } from '../format.ts';
import { ReliabilityChart, Square, TabbedPanels, Tile, Waffle, Why, type TabKey } from './explore-parts.tsx';

// The explorer for extraction benches (VRDU). Same three tabs as the closed-choice explorer. A "field" is one value
// of one document (a form has six). Wording stays factual: what was measured, on how many fields.

const n0 = (x: number) => x.toLocaleString('en-US');
const FIELD_NAMES: Record<string, string> = {
  file_date: 'date of signature',
  foreign_principle_name: 'foreign principal entry',
  registrant_name: 'registrant name',
  registration_num: 'registration number',
  signer_name: 'signer name',
  signer_title: 'signer title',
};
const fieldName = (f: string) => FIELD_NAMES[f] ?? f.replace(/_/g, ' ');

export function ExploreExtract({ d, tab }: { d: ExtractExploreResponse; tab: TabKey }) {
  return (
    <TabbedPanels
      benchId={d.benchId}
      tab={tab}
      panels={{ try: <TryIt d={d} />, results: <Results d={d} />, method: <Method d={d} /> }}
    />
  );
}

// ---------------------------------------------------------------- 1. Try it

function TryIt({ d }: { d: ExtractExploreResponse }) {
  if (!d.calibration) {
    return (
      <p className="note note-warn">
        This part replays the benchmark’s calibration fields, which are not available: {d.calibrationMissingReason ?? 'the calibration run is missing'}. The Results and
        How-it-was-tested tabs still work.
      </p>
    );
  }
  return <TryItInner d={d} />;
}

const PIPELINES: Array<{ key: Pipeline; name: string; desc: string }> = [
  { key: 'simple', name: 'Writer, checker, person', desc: 'A field the checker does not accept goes to a person with the first value filled in.' },
  { key: 'full', name: 'With the stronger re-extraction', desc: 'A field the checker does not accept is extracted again by a stronger model and checked again; only then does it go to a person.' },
];

function TryItInner({ d }: { d: ExtractExploreResponse }) {
  const cal = d.calibration!;
  const [targetPct, setTargetPct] = useState(Math.min(99, Math.max(80, Math.round(d.target * 100))));
  const [checker, setChecker] = useState(cal.models.includes(d.decision) ? d.decision : cal.models[0]!);
  const [pipeline, setPipeline] = useState<Pipeline>('simple');
  const r = useMemo(() => replayExtract(cal.slots, checker, targetPct / 100, pipeline), [cal.slots, checker, targetPct, pipeline]);
  const counts = waffleCounts(r);
  const benchFit = cal.fitsByModel[checker];
  const atBenchTarget = targetPct === Math.round(d.target * 100);
  const wrong = counts.wrong;
  const sentence = `Of 100 fields, ${counts.right} are accepted and right, ${wrong} accepted but wrong, and ${counts.check} sent to a person.`;

  return (
    <>
      <section aria-labelledby="x-setup-h">
        <h2 id="x-setup-h">1. Which checker, and which pipeline?</h2>
        <fieldset className="pick">
          <legend className="sr-only">Checker</legend>
          {cal.models.map((m) => (
            <label key={m} className={`pick-card${m === checker ? ' pick-on' : ''}`} title={m}>
              <input type="radio" name="checker" value={m} checked={m === checker} onChange={() => setChecker(m)} />
              <span className="pick-name">
                {friendlyModel(m)}
                {m === d.decision && <span className="tag tag-best">Used in the run</span>}
              </span>
              <span className="pick-desc">checks each value the writer proposes</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="pick">
          <legend className="sr-only">Pipeline</legend>
          {PIPELINES.map((p) => (
            <label key={p.key} className={`pick-card${p.key === pipeline ? ' pick-on' : ''}`}>
              <input type="radio" name="pipeline" value={p.key} checked={p.key === pipeline} onChange={() => setPipeline(p.key)} />
              <span className="pick-name">{p.name}</span>
              <span className="pick-desc">{p.desc}</span>
            </label>
          ))}
        </fieldset>
      </section>

      <section aria-labelledby="x-acc-h">
        <h2 id="x-acc-h">2. How accurate must the accepted fields be?</h2>
        <div className="card">
          <div className="slider big-slider">
            <label htmlFor="sl-x-target">Of the fields accepted automatically, at least this share should be right</label>
            <div className="slider-row">
              <input id="sl-x-target" type="range" min={80} max={99} step={1} value={targetPct} aria-valuetext={`${targetPct} percent`} onChange={(e) => setTargetPct(Number(e.target.value))} />
              <output htmlFor="sl-x-target" className="slider-value">
                {targetPct}%
              </output>
            </div>
          </div>
          <Why>
            Moving this refits the thresholds on the calibration fields: for the first check, the lowest confidence at which accepted values are right at least this
            often; for the second check (full pipeline), the same on the fields the first check did not accept. The benchmark used {Math.round(d.target * 100)}%.
          </Why>
        </div>
      </section>

      <section aria-labelledby="x-out-h">
        <h2 id="x-out-h">3. What happens to your fields</h2>
        <div className="card outcome">
          <Waffle counts={counts} sentenceId="x-outcome-sentence" />
          <div className="outcome-text">
            <p className="outcome-sentence" id="x-outcome-sentence" aria-live="polite">
              {sentence}
            </p>
            <ul className="legend waffle-legend" aria-hidden="true">
              <li>
                <Square state="right" /> {counts.right} accepted and right
              </li>
              <li>
                <Square state="wrong" /> {counts.wrong} accepted but wrong
              </li>
              <li>
                <Square state="check" /> {counts.check} sent to a person
              </li>
            </ul>
            <div className="tiles tiles-outcome">
              <Tile label="Right, among the accepted" value={formatPct(r.precision, 1)} why="Of the fields accepted automatically, the share whose value matched the gold label (dates, digits and text compared after normalising)." />
              <Tile label="Accepted automatically" value={formatPct(r.acceptedShare, 1)} why="Fields whose value the checker accepted, so no person looks at them." />
              <Tile
                label="Confident wrong, per 1,000 fields"
                value={r.confidentWrongPer1000.toFixed(1)}
                why="Fields accepted automatically whose value is wrong, counted per 1,000 fields of all kinds."
              />
              <Tile
                label="Thresholds"
                value={pipeline === 'full' ? `${thresholdText(r.t1)} / ${thresholdText(r.t2 ?? 1.01)}` : thresholdText(r.t1)}
                why="A value is accepted when the checker says “supported” with at least this probability. The first number is for the first check, the second (full pipeline) for the re-extracted value. “never” means that step accepts nothing."
              />
            </div>
            {atBenchTarget && benchFit && (
              <p className="small muted">
                The benchmark’s calibration file has t1 = {benchFit.verify1 === undefined ? 'n/a' : thresholdText(benchFit.verify1)}
                {benchFit.verify2Conditional === undefined ? '' : ` and t2 = ${thresholdText(benchFit.verify2Conditional)}`} for this checker at {targetPct}%.
              </p>
            )}
          </div>
        </div>
        <p className="small muted">
          The squares replay the {n0(r.n)} fields of the {n0(cal.documents)} calibration documents the thresholds were fitted on, so the shares differ slightly from the test split on
          the Results tab.
        </p>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- 2. Results

const Row = ({ name, m, note }: { name: ReactNode; m: ExtractSlotMetrics; note?: ReactNode }) => (
  <tr>
    <th scope="row">
      {name}
      {note && <span className="small muted block">{note}</span>}
    </th>
    <td className="num">{n0(m.fields)}</td>
    <td className="num">{formatPct(m.acceptedShare, 1)}</td>
    <td className="num">{formatPct(m.precision, 1)}</td>
    <td className="num">
      {n0(m.confidentWrong)} ({formatPct(m.confidentWrongShare, 2)})
    </td>
    <td className="num">{formatPct(m.flaggedShare, 1)}</td>
    <td className="num">{formatPct(m.flaggedOwnRight, 1)}</td>
    <td className="num">{formatPct(m.accuracy, 1)}</td>
  </tr>
);

const SlotHead = ({ first }: { first: string }) => (
  <thead>
    <tr>
      <th scope="col">{first}</th>
      <th scope="col" className="num">Fields</th>
      <th scope="col" className="num">Accepted</th>
      <th scope="col" className="num">Right, among the accepted</th>
      <th scope="col" className="num">Accepted but wrong</th>
      <th scope="col" className="num">Sent to a person</th>
      <th scope="col" className="num">Flagged, the tool’s value right</th>
      <th scope="col" className="num">Right overall, own values</th>
    </tr>
  </thead>
);

function Results({ d }: { d: ExtractExploreResponse }) {
  const r = d.report;
  const c = r.configs;
  const w = c.writerAlone;
  const th = (x: number) => thresholdText(x);
  const cost = (m: { costPer1kDocuments: ExtractConfigMetrics['costPer1kDocuments'] }) => m.costPer1kDocuments;
  return (
    <>
      <section aria-labelledby="x-res-h">
        <h2 id="x-res-h">Results on the test split</h2>
        <p className="muted">
          {n0(r.documents)} documents, {n0(r.fields)} fields, never seen during calibration. Thresholds fitted for {Math.round(r.target * 100)}% accepted-field precision with{' '}
          {friendlyModel(r.decisionModel)} as the checker; baseline {friendlyModel(r.baselineModel)}.
          {r.debugOnly && ' This is the dev split: the numbers are for debugging only.'}
        </p>
        <div className="card flush table-wrap">
          <table className="data results">
            <caption className="sr-only">Configurations on the same documents</caption>
            <SlotHead first="Configuration" />
            <tbody>
              <Row name="Baseline: every field taken as is" m={c.baseline} />
              <tr>
                <th scope="row">
                  Writer alone
                  <span className="small muted block">the first-read values, no checker</span>
                </th>
                <td className="num">{n0(w.fields)}</td>
                <td className="num" colSpan={5}>
                  no checker
                </td>
                <td className="num">{formatPct(w.accuracy, 1)}</td>
              </tr>
              <Row name="Simple: writer, checker, person" m={c.simple} />
              <Row name="Full: with the stronger re-extraction" m={c.full} />
              {r.refit && <Row name="Full, first read" m={r.refit.fullFirstRead} note="the second-check threshold fitted on all calibration fields" />}
            </tbody>
          </table>
        </div>
        {w.unusableDocuments > 0 && <p className="small muted">Writer alone: {n0(w.unusableDocuments)} document(s) had no usable reply; their fields count as wrong.</p>}
        {r.refit && (
          <div className="note" role="note">
            <strong>Method change after the first test read.</strong> The second-check threshold was first fitted on all calibration fields (t2 = {th(r.refit.previousThresholds.t2)}).
            In a real run the second check only decides the fields the first check did not accept, which are the harder ones, so that fit did not match the population it was
            used on. The test split had already been read once with it. The threshold was then refitted on the calibration fields the first check did not accept (t2 ={' '}
            {th(r.thresholds.t2)}), using calibration data only and no model calls; the test ledgers were replayed under the new value, and t1 = {th(r.thresholds.t1)} did not
            change. Both reads are in the table.
          </div>
        )}
      </section>

      <section aria-labelledby="x-pres-h">
        <h2 id="x-pres-h">Value present or absent in the gold</h2>
        <p className="muted small">A null is right only when the form does not state the field.</p>
        <div className="card flush table-wrap">
          <table className="data results">
            <caption className="sr-only">Present versus absent, for the full and the simple pipeline</caption>
            <SlotHead first="Pipeline, gold" />
            <tbody>
              {(['full', 'simple'] as const).flatMap((k) => [
                <Row key={`${k}p`} name={`${k}: has a value`} m={r.presence[k].present} />,
                <Row key={`${k}a`} name={`${k}: blank (absent)`} m={r.presence[k].absent} />,
              ])}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="x-field-h">
        <h2 id="x-field-h">Per field</h2>
        <div className="card flush table-wrap">
          <table className="data results">
            <caption className="sr-only">Per field, full pipeline then simple</caption>
            <SlotHead first="Field" />
            <tbody>
              {(['full', 'simple'] as const).flatMap((k) =>
                Object.entries(r.perField[k]).map(([f, m]) => <Row key={`${k}${f}`} name={`${fieldName(f)} (${k})`} m={m} />),
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="x-chk-h">
        <h2 id="x-chk-h">Checkers, first check only</h2>
        <p className="muted small">Each checker judges the same first-read values, at its own fitted threshold.</p>
        <div className="card flush table-wrap">
          <table className="data results">
            <caption className="sr-only">Checkers on the first-read values</caption>
            <thead>
              <tr>
                <th scope="col">Checker</th>
                <th scope="col" className="num">Threshold</th>
                <th scope="col" className="num">Fields</th>
                <th scope="col" className="num">Accepted</th>
                <th scope="col" className="num">Right, among the accepted</th>
                <th scope="col" className="num">Accepted but wrong</th>
                <th scope="col" className="num">“cannot tell” on values</th>
                <th scope="col" className="num">“cannot tell” on nulls</th>
              </tr>
            </thead>
            <tbody>
              {r.checkers.map((k) => (
                <tr key={k.model}>
                  <th scope="row" title={k.model}>
                    {friendlyModel(k.model)}
                  </th>
                  <td className="num">{th(k.threshold)}</td>
                  <td className="num">{n0(k.slots)}</td>
                  <td className="num">{formatPct(k.acceptedShare, 1)}</td>
                  <td className="num">{formatPct(k.precision, 1)}</td>
                  <td className="num">{n0(k.confidentWrong)}</td>
                  <td className="num">
                    {n0(k.cannotTell.value.cannotTell)} of {n0(k.cannotTell.value.proposals)}
                  </td>
                  <td className="num">
                    {n0(k.cannotTell.null.cannotTell)} of {n0(k.cannotTell.null.proposals)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {r.operatingPoint && (
        <section aria-labelledby="x-op-h">
          <h2 id="x-op-h">{Math.round(r.operatingPoint.target * 100)}% operating point</h2>
          <p className="muted small">
            The same calibration refitted for {Math.round(r.operatingPoint.target * 100)}% precision and replayed on the test split with no model calls: t1 ={' '}
            {th(r.operatingPoint.thresholds.t1)}, t2 = {th(r.operatingPoint.thresholds.t2)}.
          </p>
          <div className="card flush table-wrap">
            <table className="data results">
              <caption className="sr-only">Operating point</caption>
              <SlotHead first="Configuration" />
              <tbody>
                <Row name="Simple" m={r.operatingPoint.simple} />
                {r.operatingPoint.full.pending > 0 ? (
                  <tr>
                    <th scope="row">Full</th>
                    <td colSpan={7} className="muted">
                      not replayable: {n0(r.operatingPoint.full.pending)} fields would need a round-2 answer the run did not ask for
                    </td>
                  </tr>
                ) : (
                  <Row name="Full" m={r.operatingPoint.full} />
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section aria-labelledby="x-cost-h">
        <h2 id="x-cost-h">Cost per 1,000 documents, by stage</h2>
        <p className="muted small">Test runs only; calibration spend is not included.</p>
        <div className="card flush table-wrap">
          <table className="data results">
            <caption className="sr-only">Cost by stage in US dollars per 1,000 documents</caption>
            <thead>
              <tr>
                <th scope="col">Configuration</th>
                <th scope="col" className="num">Write 1</th>
                <th scope="col" className="num">Check 1</th>
                <th scope="col" className="num">Write 2</th>
                <th scope="col" className="num">Check 2</th>
                <th scope="col" className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['Baseline', cost(c.baseline)],
                  ['Writer alone', cost(w)],
                  ['Simple', cost(c.simple)],
                  ['Full', cost(c.full)],
                ] as const
              ).map(([name, k]) => (
                <tr key={name}>
                  <th scope="row">{name}</th>
                  <td className="num">{formatUsd(k.write1)}</td>
                  <td className="num">{formatUsd(k.verify1)}</td>
                  <td className="num">{formatUsd(k.write2)}</td>
                  <td className="num">{formatUsd(k.verify2)}</td>
                  <td className="num">
                    <strong>{formatUsd(k.total)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- 3. How it was tested

function Method({ d }: { d: ExtractExploreResponse }) {
  const r = d.report;
  const ece = (x: number | null | undefined) => (x === null || x === undefined || Number.isNaN(x) ? '—' : x.toFixed(3));
  return (
    <>
      <section aria-labelledby="x-split-h">
        <h2 id="x-split-h">Two splits of documents</h2>
        <p>
          Thresholds were fitted on {n0(r.calibration.documents)} calibration documents (run <code>{r.calibration.runId}</code>), one point per field. The results were measured on{' '}
          {n0(r.documents)} different test documents ({n0(r.fields)} fields).{r.refit ? ' The round-2 threshold was refitted after the first test read; see the Results tab.' : ''}
        </p>
        <Why label="What is ECE?">
          Expected calibration error: fields are sorted into 10 equal-width bins by the checker’s p(supported); ECE is the average gap between the mean p and the share of values that
          were right in each bin, weighted by bin size. Lower is better; 0 means the probabilities match how often the checker is right.
        </Why>
        <Why label="What does “calibrated” mean?">
          An isotonic regression, fitted on the calibration split, maps the checker’s probabilities to the share that were right. On the calibration split the calibrated ECE is
          2-fold out of sample (fitted on one half, measured on the other); on the test split it uses the calibration split’s fit, so it is held out too.
        </Why>
      </section>

      <section aria-labelledby="x-ece-h">
        <h2 id="x-ece-h">Calibration split against test split</h2>
        <div className="card flush table-wrap">
          <table className="data results">
            <caption className="sr-only">AUC and ECE, calibration split against test split, per checker, first check</caption>
            <thead>
              <tr>
                <th scope="col">Checker</th>
                <th scope="col" className="num">Calibration fields</th>
                <th scope="col" className="num">AUC (calibration)</th>
                <th scope="col" className="num">ECE raw (calibration)</th>
                <th scope="col" className="num">ECE calibrated (calibration)</th>
                <th scope="col" className="num">Test fields</th>
                <th scope="col" className="num">ECE raw (test)</th>
                <th scope="col" className="num">ECE calibrated (test)</th>
              </tr>
            </thead>
            <tbody>
              {r.checkers.map((k) => {
                const q = r.calibration.models[k.model];
                return (
                  <tr key={k.model}>
                    <th scope="row" title={k.model}>
                      {friendlyModel(k.model)}
                    </th>
                    <td className="num">{q?.verify1 ? n0(q.verify1.slots) : '—'}</td>
                    <td className="num">{ece(q?.verify1Quality?.auc)}</td>
                    <td className="num">{ece(q?.verify1Quality?.eceRaw)}</td>
                    <td className="num">{ece(q?.verify1Quality?.eceCalibrated)}</td>
                    <td className="num">{n0(k.slots)}</td>
                    <td className="num">{ece(k.reliability.eceRaw)}</td>
                    <td className="num">{ece(k.reliability.eceCalibrated)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="x-rel-h">
        <h2 id="x-rel-h">Reliability on the test split</h2>
        <p className="muted small">
          Each dot is a bin of fields: across is what the checker said (p(supported)), up is the share of those values that were right. On the dotted diagonal the checker says
          what is true.
        </p>
        <ul className="legend">
          <li>
            <svg width="22" height="10" aria-hidden="true">
              <circle cx="11" cy="5" r="4" className="dot-raw" />
            </svg>
            as the checker said it (raw)
          </li>
          <li>
            <svg width="22" height="10" aria-hidden="true">
              <circle cx="11" cy="5" r="4" className="dot-cal" />
            </svg>
            after the isotonic fit (calibrated)
          </li>
        </ul>
        <div className="rel-grid">
          {r.checkers.map((k) => (
            <ReliabilityChart
              key={k.model}
              r={{ ...k.reliability, n: k.reliability.raw.reduce((n, b) => n + b.n, 0), unit: 'fields' }}
              title={`${friendlyModel(k.model)} · first check`}
              subtitle="checker's p(supported) for the first-read value"
              tooltip={k.model}
            />
          ))}
        </div>
      </section>
    </>
  );
}
