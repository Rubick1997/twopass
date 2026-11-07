// A tiny Markdown parser for bench-report.md: headings, paragraphs, bullet lists, pipe tables,
// and inline `code` / **bold**. It returns blocks; the React side renders them as elements
// (never as HTML strings), so the report's text can't inject markup.

export type Inline = { kind: 'text' | 'code' | 'bold'; text: string };

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; text: Inline[] }
  | { kind: 'paragraph'; text: Inline[] }
  | { kind: 'list'; items: Inline[][] }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][] };

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push({ kind: 'text', text: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[1] });
    else out.push({ kind: 'bold', text: m[2] ?? '' });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ kind: 'text', text: s.slice(last) });
  return out;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => parseInline(c.trim()));

const isDivider = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'paragraph', text: parseInline(para.join(' ')) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1]!.length as 1 | 2 | 3 | 4, text: parseInline(heading[2]!.trim()) });
    } else if (line.trim().startsWith('|') && isDivider(lines[i + 1] ?? '')) {
      flush();
      const header = cells(line);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith('|')) rows.push(cells(lines[i++]!));
      i--;
      blocks.push({ kind: 'table', header, rows });
    } else if (/^\s*[-*]\s+/.test(line)) {
      flush();
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) items.push(parseInline(lines[i++]!.replace(/^\s*[-*]\s+/, '')));
      i--;
      blocks.push({ kind: 'list', items });
    } else if (line.trim() === '') flush();
    else para.push(line.trim());
  }
  flush();
  return blocks;
}
