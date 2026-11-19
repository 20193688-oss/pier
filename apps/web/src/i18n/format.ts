/* `{name}` placeholders filled from `vars`; an unknown placeholder stays as written. Pure. */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.hasOwn(vars, key) ? String(vars[key]) : whole,
  );
}
