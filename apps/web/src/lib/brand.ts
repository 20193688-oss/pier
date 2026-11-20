/* The product's name, in one place: the product will be renamed, so no component or translation
   writes it. Translation strings say `{brand}` and the i18n provider fills it in from here
   (src/i18n/index.tsx); code that needs the name outside a translation imports BRAND. Technical
   names that are part of the API contract (the `pedospe-signature` webhook header, the
   `Pedospe-Organization` request header, storage keys, the `@pedospe/*` packages) are not the
   brand and do not change with it. */
export const BRAND = {
  /* The name as people read it, set lower-case like the wordmark. */
  name: 'pedospe',
  /* The installed app's short name (home screen label). */
  shortName: 'pedospe',
} as const;

/** Every `{brand}` placeholder in a translation catalog, filled with the product's name. */
export function withBrand<T>(value: T, name: string = BRAND.name): T {
  if (typeof value === 'string') return value.replaceAll('{brand}', name) as T;
  if (Array.isArray(value)) return value.map((v) => withBrand(v, name)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, withBrand(v, name)]),
    ) as T;
  }
  return value;
}
