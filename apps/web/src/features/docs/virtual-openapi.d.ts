/* The API's OpenAPI document, provided at build time by the `pier-openapi` plugin in
   vite.config.ts: the parsed apps/api/openapi.json, or null while the API has not published it. */
declare module 'virtual:openapi' {
  const spec: Record<string, unknown> | null;
  export default spec;
}
