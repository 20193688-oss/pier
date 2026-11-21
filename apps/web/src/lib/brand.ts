/* The product's name, in one place: no component or translation writes it. Translation strings say
   `{brand}` and the i18n provider fills it in from here (src/i18n/index.tsx); code that needs the
   name outside a translation imports BRAND. Technical names that are part of the API contract (the
   `midpoint-signature` webhook header, the `Midpoint-Organization` request header, storage keys,
   the `@midpoint/*` packages) are not the display name and do not change with it. */
export const BRAND = {
  /* The name as people read it in a sentence. The wordmark (Logo.tsx) draws it from generated
     outlines (logo-paths.ts, scripts/gen-logo.py): a new name means generating them again. */
  name: 'Midpoint',
  /* The installed app's short name (home screen label). */
  shortName: 'Midpoint',
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
