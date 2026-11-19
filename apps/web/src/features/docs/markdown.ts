/* markdown.ts: the docs' long text lives in the translation catalogs as a list of blocks, one
   string per block, the same blocks in the same order in every language. This reads them into a
   small tree the page renders as React elements (never as HTML), so a catalog string can never
   inject markup.

   One string is one block:
     '## Title' / '### Title'   a heading (gets an id for links)
     '- item'                   a bullet item; consecutive items form one list
     '1. item'                  a numbered item, for real sequences only
     '| a | b |'                a table row; the first row is the head, a '|---|' row is skipped
     '> text'                   a note; '!> text' a warning
     '@@code name'              a code sample from snippets.ts (code is not translated)
     anything else              a paragraph
   Inline, in any text: `code`, **bold**, [label](/internal/path) or [label](https://...).
   Pure; tests/unit/docs.test.ts. */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; children: Inline[] }
  | { kind: 'link'; href: string; internal: boolean; children: Inline[] };

export type Block =
  | { kind: 'heading'; level: 2 | 3; id: string; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { kind: 'note'; tone: 'info' | 'warn'; children: Inline[] }
  | { kind: 'code'; name: string };

const TOKEN = /(`[^`]+`)|(\*\*(?:[^*]|\*(?!\*))+\*\*)|(\[[^\]]+\]\([^)\s]+\))/g;

/** Only a path inside this site or an https address is a link; anything else stays text. */
export function safeHref(href: string): { href: string; internal: boolean } | null {
  if (/^\/(?!\/)[^\s]*$/.test(href)) return { href, internal: true };
  if (/^#[\w-]+$/.test(href)) return { href, internal: false };
  if (/^https:\/\/[^\s]+$/.test(href)) return { href, internal: false };
  return null;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  const push = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.kind === 'text') last.text += t;
    else out.push({ kind: 'text', text: t });
  };
  for (const m of text.matchAll(TOKEN)) {
    push(text.slice(at, m.index));
    const [whole, code, bold, link] = m;
    if (code) out.push({ kind: 'code', text: code.slice(1, -1) });
    else if (bold) out.push({ kind: 'bold', children: parseInline(bold.slice(2, -2)) });
    else if (link) {
      const close = link.indexOf('](');
      const label = link.slice(1, close);
      const target = safeHref(link.slice(close + 2, -1));
      if (target) out.push({ kind: 'link', ...target, children: parseInline(label) });
      else push(label);
    } else push(whole);
    at = (m.index ?? 0) + whole.length;
  }
  push(text.slice(at));
  return out;
}

/** A heading's anchor id: lower case, letters and digits joined by hyphens. */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

export function parseBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  const seen = new Map<string, number>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const last = blocks[blocks.length - 1];
    let m: RegExpExecArray | null;
    if ((m = /^(#{2,3})\s+(.+)$/.exec(line))) {
      const base = slugify(m[2]) || 'section';
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      blocks.push({
        kind: 'heading',
        level: m[1].length as 2 | 3,
        id: n ? `${base}-${n + 1}` : base,
        children: parseInline(m[2]),
      });
    } else if ((m = /^-\s+(.+)$/.exec(line))) {
      const item = parseInline(m[1]);
      if (last?.kind === 'list' && !last.ordered) last.items.push(item);
      else blocks.push({ kind: 'list', ordered: false, items: [item] });
    } else if ((m = /^\d+\.\s+(.+)$/.exec(line))) {
      const item = parseInline(m[1]);
      if (last?.kind === 'list' && last.ordered) last.items.push(item);
      else blocks.push({ kind: 'list', ordered: true, items: [item] });
    } else if (line.startsWith('|')) {
      const row = cells(line);
      if (row.every((c) => /^:?-{3,}:?$/.test(c))) continue;
      if (last?.kind === 'table') last.rows.push(row.map(parseInline));
      else blocks.push({ kind: 'table', head: row.map(parseInline), rows: [] });
    } else if ((m = /^(!?)>\s+(.+)$/.exec(line))) {
      blocks.push({ kind: 'note', tone: m[1] ? 'warn' : 'info', children: parseInline(m[2]) });
    } else if ((m = /^@@code\s+([\w-]+)$/.exec(line))) {
      blocks.push({ kind: 'code', name: m[1] });
    } else {
      blocks.push({ kind: 'paragraph', children: parseInline(line) });
    }
  }
  return blocks;
}

/** The plain text of inline content (for search and for headings' labels). */
export function plainText(nodes: readonly Inline[]): string {
  return nodes
    .map((n) => (n.kind === 'text' || n.kind === 'code' ? n.text : plainText(n.children)))
    .join('');
}
