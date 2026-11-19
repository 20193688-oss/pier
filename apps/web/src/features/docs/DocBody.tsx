/* A guide's blocks (src/features/docs/markdown.ts) drawn as React elements: headings with anchors,
   lists, tables that scroll sideways on a phone, notes, and code samples with a copy button.
   Text is always text: nothing from a catalog becomes markup. */
import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useT } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { CopyButton } from '@/components/ui/misc';
import { parseBlocks, type Block, type Inline } from '@/features/docs/markdown';
import { SNIPPETS } from '@/features/docs/snippets';

export function InlineText({ nodes }: { nodes: readonly Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.kind) {
          case 'text':
            return <Fragment key={i}>{n.text}</Fragment>;
          case 'code':
            return <code key={i}>{n.text}</code>;
          case 'bold':
            return (
              <strong key={i}>
                <InlineText nodes={n.children} />
              </strong>
            );
          case 'link':
            return n.internal ? (
              <Link key={i} to={n.href}>
                <InlineText nodes={n.children} />
              </Link>
            ) : (
              <a
                key={i}
                href={n.href}
                {...(n.href.startsWith('https:')
                  ? { target: '_blank', rel: 'noopener noreferrer' }
                  : {})}
              >
                <InlineText nodes={n.children} />
              </a>
            );
        }
      })}
    </>
  );
}

export function CodeSample({ name }: { name: string }) {
  const t = useT();
  const d = t.docs;
  const snippet = SNIPPETS[name];
  if (!snippet) return null;
  return (
    <figure className="not-prose mb-5 overflow-hidden rounded-[16px] border border-line bg-well">
      <figcaption className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
        <span className="text-[0.8125rem] font-semibold text-ink-3">{d.code[snippet.lang]}</span>
        <CopyButton value={snippet.code} label={d.code.label} />
      </figcaption>
      <pre className="m-0! overflow-x-auto rounded-none! bg-transparent! px-4 py-3.5 text-[0.8125rem] leading-relaxed">
        <code>{snippet.code}</code>
      </pre>
    </figure>
  );
}

function Note({ tone, children }: { tone: 'info' | 'warn'; children: ReactNode }) {
  const t = useT();
  return (
    <aside
      className={`mb-5 flex gap-3 rounded-[16px] px-4 py-3.5 ${tone === 'warn' ? 'bg-warn-soft' : 'bg-info-soft'}`}
      aria-label={tone === 'warn' ? t.docs.warnLabel : t.docs.noteLabel}
    >
      <Icon
        name={tone === 'warn' ? 'alert' : 'info'}
        className={`mt-0.5 shrink-0 ${tone === 'warn' ? 'text-warn' : 'text-info'}`}
      />
      <p className="m-0! text-ink!">{children}</p>
    </aside>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading':
      return block.level === 2 ? (
        <h2 id={block.id} className="scroll-mt-24">
          <InlineText nodes={block.children} />
        </h2>
      ) : (
        <h3 id={block.id} className="scroll-mt-24">
          <InlineText nodes={block.children} />
        </h3>
      );
    case 'paragraph':
      return (
        <p>
          <InlineText nodes={block.children} />
        </p>
      );
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i}>
          <InlineText nodes={item} />
        </li>
      ));
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case 'table':
      return (
        <div className="mb-5 overflow-x-auto rounded-[16px] border border-line">
          <table className="table min-w-[32rem] text-[0.875rem]">
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i} scope="col">
                    <InlineText nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i} className="align-top text-ink-2">
                      <InlineText nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'note':
      return (
        <Note tone={block.tone}>
          <InlineText nodes={block.children} />
        </Note>
      );
    case 'code':
      return <CodeSample name={block.name} />;
  }
}

/** A guide's body, from its catalog blocks. */
export function DocBody({ lines }: { lines: readonly string[] }) {
  return (
    <div className="prose-doc">
      {parseBlocks(lines).map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}
