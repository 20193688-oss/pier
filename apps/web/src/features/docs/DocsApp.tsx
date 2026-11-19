/* The docs (/docs/*): an index of sections on the left (a disclosure on phones), the page on the
   right, the previous and next pages under it. Guides come from the `docs` catalog as blocks
   (DocBody); the API reference from the API's OpenAPI document (ApiReference). */
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useParams } from 'react-router';
import { useDocumentMeta, useT } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { DocBody } from '@/features/docs/DocBody';
import { ApiReference } from '@/features/docs/ApiReference';
import { DOC_PAGES, docPath, findDocPage, type DocPage } from '@/features/docs/pages';

function DocsNav({ current, onPick }: { current: DocPage | null; onPick: () => void }) {
  const t = useT();
  const d = t.docs;
  const groups = (['start', 'guides', 'reference'] as const).map((g) => ({
    g,
    pages: DOC_PAGES.filter((p) => p.group === g),
  }));
  return (
    <nav aria-label={d.navLabel} className="flex flex-col gap-5">
      {groups.map(({ g, pages }) => (
        <div key={g}>
          <h2
            className="mb-1.5 px-3 text-[0.8125rem] font-semibold text-ink-3"
            style={{ fontStretch: '100%' }}
          >
            {d.groups[g]}
          </h2>
          <ul className="flex flex-col" role="list">
            {pages.map((p) => (
              <li key={p.key}>
                <NavLink
                  to={docPath(p)}
                  end
                  onClick={onPick}
                  aria-current={current?.key === p.key ? 'page' : undefined}
                  className={`block rounded-[10px] px-3 py-2 text-[0.9375rem] transition-colors ${current?.key === p.key ? 'bg-well font-semibold text-ink' : 'text-ink-2 hover:text-ink'}`}
                >
                  {d.pages[p.key].nav}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export default function DocsApp() {
  const t = useT();
  const d = t.docs;
  const params = useParams();
  const { pathname, hash } = useLocation();
  const page = findDocPage(params['*'] ?? '');
  const [open, setOpen] = useState(false);
  const words = page ? d.pages[page.key] : null;
  useDocumentMeta(words ? `${words.title} | pedospe` : d.metaTitle, words?.description);

  // A link to a heading lands on it; a new page starts at its top.
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    el?.scrollIntoView();
  }, [pathname, hash]);

  const at = page ? DOC_PAGES.indexOf(page) : -1;
  const prev = at > 0 ? DOC_PAGES[at - 1] : null;
  const next = at >= 0 && at < DOC_PAGES.length - 1 ? DOC_PAGES[at + 1] : null;

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-6 px-4 pt-6 pb-10 md:pt-10 lg:grid-cols-[14.5rem_minmax(0,1fr)] lg:gap-12">
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 rounded-[14px] border border-line bg-sheet px-4 py-3 text-left font-semibold lg:hidden"
          aria-expanded={open}
          aria-controls="docs-nav"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Icon name="book" size={18} className="shrink-0 text-ink-3" />
            <span className="truncate">{words ? words.nav : d.sections}</span>
          </span>
          <Icon
            name="chevron"
            size={18}
            className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
        <div
          id="docs-nav"
          className={`${open ? 'block' : 'hidden'} mt-3 rounded-[16px] border border-line bg-sheet p-2 lg:mt-0 lg:block lg:border-0 lg:bg-transparent lg:p-0`}
        >
          <DocsNav current={page} onPick={() => setOpen(false)} />
        </div>
      </aside>

      <article className="min-w-0" aria-labelledby="doc-title">
        {page && words ? (
          <>
            <header className="mb-8 border-b border-line pb-6">
              <h1
                id="doc-title"
                className="text-[2rem] leading-[1.08] sm:text-[2.5rem]"
                style={{ fontStretch: '115%' }}
              >
                {words.title}
              </h1>
              <p className="mt-3 max-w-[62ch] text-[1.0625rem] text-ink-2">{words.description}</p>
            </header>
            <DocBody lines={words.body} />
            {page.key === 'api' && (
              <div className="mt-2">
                <ApiReference />
              </div>
            )}
            {(prev || next) && (
              <nav
                aria-label={d.pager}
                className="mt-12 grid grid-cols-2 gap-3 border-t border-line pt-6"
              >
                {prev ? (
                  <Link
                    to={docPath(prev)}
                    className="flex flex-col gap-1 rounded-[14px] border border-line px-4 py-3 hover:border-ink"
                  >
                    <span className="flex items-center gap-1 text-[0.8125rem] text-ink-3">
                      <Icon name="back" size={14} />
                      {d.prev}
                    </span>
                    <span className="font-semibold">{d.pages[prev.key].nav}</span>
                  </Link>
                ) : (
                  <span />
                )}
                {next && (
                  <Link
                    to={docPath(next)}
                    className="col-start-2 flex flex-col items-end gap-1 rounded-[14px] border border-line px-4 py-3 text-right hover:border-ink"
                  >
                    <span className="flex items-center gap-1 text-[0.8125rem] text-ink-3">
                      {d.next}
                      <Icon name="chevronRight" size={14} />
                    </span>
                    <span className="font-semibold">{d.pages[next.key].nav}</span>
                  </Link>
                )}
              </nav>
            )}
          </>
        ) : (
          <div className="flex flex-col items-start gap-3 py-10">
            <h1 id="doc-title" className="text-[1.8rem]">
              {d.notFound.title}
            </h1>
            <p className="text-ink-2">{d.notFound.body}</p>
          </div>
        )}
      </article>
    </div>
  );
}
