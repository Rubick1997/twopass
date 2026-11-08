import { describe, expect, it } from 'vitest';
import { formatAgo, formatDuration, formatEta, formatPct, formatUsd, share, thresholdText } from '../ui/src/format.ts';
import { parseHash } from '../ui/src/hooks.ts';
import { parseInline, parseMarkdown } from '../ui/src/markdown.ts';

const NOW = Date.parse('2026-11-07T10:00:00Z');

describe('UI formatting', () => {
  it('money, shares and durations', () => {
    expect([0, 0.0076, 0.48, 22.25, 1234.5, null].map(formatUsd)).toEqual(['$0.00', '$0.0076', '$0.48', '$22.25', '$1,235', '—']);
    expect(formatPct(0.574, 1)).toBe('57.4%');
    expect(formatPct(null)).toBe('—');
    expect([45_000, 440_000, 3_900_000, null].map(formatDuration)).toEqual(['45 s', '7 min 20 s', '1 h 05 min', '—']);
    expect(share(3, 0)).toBeNull();
    expect(share(5, 4)).toBe(1);
    expect([0.9, 1.01].map(thresholdText)).toEqual(['0.90', 'never']);
  });

  it('ages and the expected-finish line', () => {
    expect(formatAgo(new Date(NOW - 5_000).toISOString(), NOW)).toBe('just now');
    expect(formatAgo(new Date(NOW - 3 * 60_000).toISOString(), NOW)).toBe('3 min ago');
    expect(formatAgo(null, NOW)).toBe('—');
    expect(formatEta(null, NOW)).toBe('—');
    expect(formatEta(new Date(NOW - 60_000).toISOString(), NOW)).toBe('any moment now');
    expect(formatEta(new Date(NOW + 6 * 60_000).toISOString(), NOW)).toMatch(/^in ~6 min \(.+\)$/);
    expect(formatEta(new Date(NOW + 3 * 3600_000).toISOString(), NOW)).toMatch(/^in ~3\.0 h/);
  });
});

describe('hash router', () => {
  it('parses the three routes', () => {
    expect(parseHash('')).toEqual({ page: 'home' });
    expect(parseHash('#/')).toEqual({ page: 'home' });
    expect(parseHash('#/runs/202611062156-banking77-2038-jev')).toEqual({ page: 'run', id: '202611062156-banking77-2038-jev' });
    expect(parseHash('#/benches/bench-2026-11-06-f417/')).toEqual({ page: 'bench', id: 'bench-2026-11-06-f417' });
    expect(parseHash('#/runs/a/b')).toMatchObject({ page: 'notfound' });
    expect(parseHash('#/runs/%E0%A4%A')).toMatchObject({ page: 'notfound' });
  });
});

describe('markdown', () => {
  it('parses headings, tables, lists and inline code without producing HTML', () => {
    const blocks = parseMarkdown('# Bench x\n\nThresholds from `calib` for **95%**.\n\n| A | B |\n|---|---|\n| 1 | <b>2</b> |\n\n- one\n- two\n');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'table', 'list']);
    expect(blocks[1]).toEqual({
      kind: 'paragraph',
      text: [
        { kind: 'text', text: 'Thresholds from ' },
        { kind: 'code', text: 'calib' },
        { kind: 'text', text: ' for ' },
        { kind: 'bold', text: '95%' },
        { kind: 'text', text: '.' },
      ],
    });
    const table = blocks[2] as Extract<(typeof blocks)[number], { kind: 'table' }>;
    expect(table.header.map((c) => c[0]?.text)).toEqual(['A', 'B']);
    expect(table.rows[0]![1]).toEqual([{ kind: 'text', text: '<b>2</b>' }]); // rendered as text, never markup
    expect(parseInline('plain')).toEqual([{ kind: 'text', text: 'plain' }]);
  });
});
