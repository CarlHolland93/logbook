// Confidence × agreed × outcome, from a records.jsonl.
//   pnpm reliability records.jsonl [out.svg]
// Prints the bins and the pick rate per option; writes the plot as SVG.
import { writeFileSync } from 'node:fs';
import { isMain, readLog } from './cli';
import { materialise } from './materialise';
import { signalConfirmed } from './records-to-pairs';
import type { LogRecord } from '../src/types';

export type Bin = {
  lo: number;
  hi: number;
  /** Decision cards whose confidence fell in this bin. */
  shown: number;
  /** Closed with a yes/no check-in answer. */
  scored: number;
  confirmed: number;
  /** Chosen, with a recommendation, highlight shown. */
  highlighted: number;
  agreedHighlighted: number;
  /** Chosen, with a recommendation, in the holdout. */
  heldOut: number;
  agreedHeldOut: number;
};

export type OptionRate = { id: string; label: string; shown: number; chosen: number };

export type Report = {
  records: number;
  decisionCards: number;
  bins: Bin[];
  options: OptionRate[];
};

const BIN_COUNT = 5;
/** A rate from fewer cases than this is not drawn; the table still shows it. */
export const MIN_N = 5;

export function reliability(snapshots: Iterable<LogRecord>): Report {
  const latest = materialise(snapshots);
  const bins: Bin[] = Array.from({ length: BIN_COUNT }, (_, i) => ({
    lo: i / BIN_COUNT,
    hi: (i + 1) / BIN_COUNT,
    shown: 0,
    scored: 0,
    confirmed: 0,
    highlighted: 0,
    agreedHighlighted: 0,
    heldOut: 0,
    agreedHeldOut: 0,
  }));
  const options = new Map<string, OptionRate>();
  let decisionCards = 0;

  for (const record of latest) {
    const card = record.shown.card;
    if (card.kind !== 'decision') continue;
    decisionCards++;
    const bin = bins[Math.min(BIN_COUNT - 1, Math.floor(card.signal.confidence * BIN_COUNT))]!;
    bin.shown++;

    const confirmed = signalConfirmed(record);
    if (confirmed !== undefined) {
      bin.scored++;
      if (confirmed) bin.confirmed++;
    }

    const { chose } = record;
    if (!chose) continue;
    for (const option of card.choice.options) {
      const rate = options.get(option.id) ?? { id: option.id, label: option.label, shown: 0, chosen: 0 };
      rate.shown++;
      if (option.id === chose.option_id) rate.chosen++;
      options.set(option.id, rate);
    }
    if (chose.agreed === null) continue;
    if (record.shown.highlight_shown) {
      bin.highlighted++;
      if (chose.agreed) bin.agreedHighlighted++;
    } else {
      bin.heldOut++;
      if (chose.agreed) bin.agreedHeldOut++;
    }
  }

  return {
    records: latest.length,
    decisionCards,
    bins,
    options: [...options.values()].sort((a, b) => b.chosen / b.shown - a.chosen / a.shown),
  };
}

const rate = (num: number, den: number) => (den === 0 ? undefined : num / den);
const pct = (value: number | undefined) => (value === undefined ? '-' : `${Math.round(value * 100)}%`);

export function formatReport(report: Report): string {
  const lines = [
    `${report.records} records, ${report.decisionCards} decision cards`,
    '',
    'confidence   shown  confirmed (n)   agreed, highlighted (n)   agreed, holdout (n)',
  ];
  for (const b of report.bins) {
    lines.push(
      `${b.lo.toFixed(1)} to ${b.hi.toFixed(1)}   ${String(b.shown).padStart(5)}  ${pct(rate(b.confirmed, b.scored)).padStart(5)} (${b.scored})`.padEnd(46) +
        `${pct(rate(b.agreedHighlighted, b.highlighted)).padStart(5)} (${b.highlighted})`.padEnd(26) +
        `${pct(rate(b.agreedHeldOut, b.heldOut)).padStart(5)} (${b.heldOut})`,
    );
  }
  lines.push('', 'option              shown  picked');
  for (const o of report.options) {
    lines.push(`${o.id.padEnd(20)}${String(o.shown).padStart(5)}  ${pct(rate(o.chosen, o.shown)).padStart(5)}${o.chosen === 0 ? '   never picked' : ''}`);
  }
  return lines.join('\n');
}

// Plot: one axis, three series in fixed palette order, a dotted diagonal for
// perfect calibration, legend plus direct labels, and n under each x tick.
export function renderSvg(report: Report): string {
  const W = 720;
  const H = 440;
  const pad = { top: 92, right: 190, bottom: 64, left: 56 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const x = (v: number) => pad.left + v * plotW;
  const y = (v: number) => pad.top + (1 - v) * plotH;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

  const drawn = (num: number, den: number) => (den < MIN_N ? undefined : num / den);
  const series = [
    { name: 'Signal confirmed at check-in', colour: '#2a78d6', points: report.bins.map((b) => drawn(b.confirmed, b.scored)) },
    { name: 'Agreed, highlight shown', colour: '#eb6834', points: report.bins.map((b) => drawn(b.agreedHighlighted, b.highlighted)) },
    { name: 'Agreed, holdout', colour: '#1baf7a', points: report.bins.map((b) => drawn(b.agreedHeldOut, b.heldOut)) },
  ];
  const mids = report.bins.map((b) => (b.lo + b.hi) / 2);

  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((v) => `<line x1="${x(0)}" x2="${x(1)}" y1="${y(v)}" y2="${y(v)}" stroke="#e6e5e1" stroke-width="1"/>
<text x="${x(0) - 8}" y="${y(v) + 4}" text-anchor="end" fill="#52514e" font-size="11">${Math.round(v * 100)}%</text>`)
    .join('\n');

  const xTicks = report.bins
    .map((b, i) => `<text x="${x(mids[i]!)}" y="${y(0) + 18}" text-anchor="middle" fill="#52514e" font-size="11">${b.lo.toFixed(1)} to ${b.hi.toFixed(1)}</text>
<text x="${x(mids[i]!)}" y="${y(0) + 32}" text-anchor="middle" fill="#8a8985" font-size="10">n=${b.shown}</text>`)
    .join('\n');

  const plotted = series.map((s) => ({
    ...s,
    pts: s.points.map((v, i) => (v === undefined ? null : ([x(mids[i]!), y(v)] as const))).filter((p): p is readonly [number, number] => p !== null),
  }));

  // Direct labels sit at each line's end, pushed apart so they never overlap.
  const labelY = new Map<string, number>();
  const ends = plotted.filter((s) => s.pts.length > 0).sort((a, b) => a.pts.at(-1)![1] - b.pts.at(-1)![1]);
  let floor = -Infinity;
  for (const s of ends) {
    const yy = Math.max(s.pts.at(-1)![1], floor);
    labelY.set(s.name, yy);
    floor = yy + 15;
  }

  const lines = plotted
    .map((s) => {
      const path = s.pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
      const markers = s.pts.map(([px, py]) => `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4" fill="${s.colour}" stroke="#fcfcfb" stroke-width="2"/>`).join('\n');
      const last = s.pts.at(-1);
      const label = last ? `<text x="${(last[0] + 10).toFixed(1)}" y="${(labelY.get(s.name)! + 4).toFixed(1)}" fill="#0b0b0b" font-size="11">${esc(s.name)}</text>` : '';
      return `<path d="${path}" fill="none" stroke="${s.colour}" stroke-width="2" stroke-linejoin="round"/>\n${markers}\n${label}`;
    })
    .join('\n');

  // Legend as one row under the subtitle.
  let legendX = pad.left;
  const legend = series
    .map((s) => {
      const item = `<rect x="${legendX}" y="${pad.top - 30}" width="12" height="12" rx="2" fill="${s.colour}"/>
<text x="${legendX + 18}" y="${pad.top - 20}" fill="#0b0b0b" font-size="11">${esc(s.name)}</text>`;
      legendX += 18 + s.name.length * 6.2 + 20;
      return item;
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif">
<rect width="${W}" height="${H}" fill="#fcfcfb"/>
<text x="${pad.left}" y="28" fill="#0b0b0b" font-size="15" font-weight="600">Confidence against what happened</text>
<text x="${pad.left}" y="46" fill="#52514e" font-size="12">${report.decisionCards} decision cards in ${report.records} records. Dotted line is perfect calibration. Rates from fewer than ${MIN_N} cases are not drawn.</text>
${grid}
<line x1="${x(0)}" x2="${x(1)}" y1="${y(0)}" y2="${y(1)}" stroke="#b5b4ae" stroke-width="1" stroke-dasharray="3 4"/>
<line x1="${x(0)}" x2="${x(1)}" y1="${y(0)}" y2="${y(0)}" stroke="#b5b4ae" stroke-width="1"/>
${xTicks}
<text x="${x(0.5)}" y="${H - 12}" text-anchor="middle" fill="#52514e" font-size="11">Model confidence</text>
${lines}
${legend}
</svg>
`;
}

if (isMain(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  const report = reliability(readLog(input ?? '-'));
  console.log(formatReport(report));
  if (output) {
    writeFileSync(output, renderSvg(report));
    console.log(`\nwrote ${output}`);
  }
}
