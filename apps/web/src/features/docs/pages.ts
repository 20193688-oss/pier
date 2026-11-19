/* The docs' pages in reading order: their address under /docs, their catalog key and their group
   in the index. Pure. */

export const DOC_PAGES = [
  { slug: '', key: 'overview', group: 'start' },
  { slug: 'quickstart-merchant', key: 'quickstartMerchant', group: 'start' },
  { slug: 'quickstart-bot', key: 'quickstartBot', group: 'start' },
  { slug: 'quickstart-business', key: 'quickstartBusiness', group: 'start' },
  { slug: 'collections', key: 'collections', group: 'guides' },
  { slug: 'payouts', key: 'payouts', group: 'guides' },
  { slug: 'webhooks', key: 'webhooks', group: 'guides' },
  { slug: 'security', key: 'security', group: 'guides' },
  { slug: 'api', key: 'api', group: 'reference' },
] as const;

export type DocPage = (typeof DOC_PAGES)[number];

export const docPath = (p: DocPage) => (p.slug ? `/docs/${p.slug}` : '/docs');

/** The page a path under /docs names (`''`, `quickstart-bot`, `api/`), or null. */
export function findDocPage(rest: string): DocPage | null {
  const slug = rest.replace(/^\/+|\/+$/g, '');
  return DOC_PAGES.find((p) => p.slug === slug) ?? null;
}
