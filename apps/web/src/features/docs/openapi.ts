/* openapi.ts: the API's OpenAPI 3 document (apps/api/openapi.json) flattened into what the docs'
   reference page draws: operations grouped by tag, each with its parameters, its request body's
   fields, its responses and who may call it. `$ref`s to components are resolved (a nested object
   is named by its schema, not expanded, so a cycle cannot loop). Pure; tests/unit/docs.test.ts. */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
export type Method = (typeof METHODS)[number];

export interface FieldView {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
}

export interface SchemaView {
  /* The schema's own label ("Order", "Order[]", "object", "string"). */
  type: string;
  description: string | null;
  fields: FieldView[];
}

export interface ParamView extends FieldView {
  in: string;
}

export interface ResponseView {
  code: string;
  description: string | null;
  schema: SchemaView | null;
}

export interface OperationView {
  id: string;
  method: Method;
  path: string;
  summary: string | null;
  description: string | null;
  deprecated: boolean;
  params: ParamView[];
  body: { contentType: string; required: boolean; schema: SchemaView } | null;
  responses: ResponseView[];
  /* The security schemes any one of which lets a caller in; empty when the route is public. */
  security: string[];
}

export interface GroupView {
  tag: string | null;
  description: string | null;
  operations: OperationView[];
}

export interface SpecView {
  title: string | null;
  version: string | null;
  description: string | null;
  groups: GroupView[];
  count: number;
}

/** The object a local `$ref` ('#/components/schemas/Order') points to, or null. */
export function resolveRef(spec: Obj, ref: string): Obj | null {
  if (!ref.startsWith('#/')) return null;
  let at: unknown = spec;
  for (const part of ref.slice(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObj(at) || !(key in at)) return null;
    at = at[key];
  }
  return isObj(at) ? at : null;
}

const refName = (ref: string) => ref.split('/').pop() ?? ref;

/** Follow `$ref`s (a few hops at most) to the object they name. */
function deref(spec: Obj, v: unknown, hops = 0): Obj | null {
  if (!isObj(v)) return null;
  if (typeof v.$ref === 'string' && hops < 8)
    return deref(spec, resolveRef(spec, v.$ref), hops + 1);
  return v;
}

/** A schema as a short type label: its component's name, an item type with [], an enum's values,
    alternatives joined by |, a format in brackets. */
export function typeLabel(spec: Obj, schema: unknown, depth = 0): string {
  if (!isObj(schema)) return 'any';
  if (typeof schema.$ref === 'string') return refName(schema.$ref);
  if (depth > 4) return 'object';
  const nullable =
    schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes('null'));
  const withNull = (s: string) => (nullable && !s.endsWith('| null') ? `${s} | null` : s);
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const values = schema.enum
      .filter((x) => x !== null)
      .map((x) => (typeof x === 'string' ? `'${x}'` : String(x)));
    return withNull(
      values.length > 6 ? `${values.slice(0, 6).join(' | ')} | …` : values.join(' | '),
    );
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    const alts = schema[key];
    if (Array.isArray(alts) && alts.length)
      return withNull(alts.map((a) => typeLabel(spec, a, depth + 1)).join(' | '));
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    return withNull(
      schema.allOf.length === 1 ? typeLabel(spec, schema.allOf[0], depth + 1) : 'object',
    );
  }
  const type = Array.isArray(schema.type) ? schema.type.find((x) => x !== 'null') : schema.type;
  if (type === 'array') return withNull(`${typeLabel(spec, schema.items, depth + 1)}[]`);
  if (typeof type === 'string')
    return withNull(typeof schema.format === 'string' ? `${type} (${schema.format})` : type);
  if (isObj(schema.properties)) return withNull('object');
  return 'any';
}

/** An object schema's fields (allOf parts merged), with which are required. */
function fieldsOf(spec: Obj, schema: Obj | null, depth = 0): FieldView[] {
  if (!schema || depth > 6) return [];
  const out: FieldView[] = [];
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) out.push(...fieldsOf(spec, deref(spec, part), depth + 1));
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((x): x is string => typeof x === 'string')
      : [],
  );
  if (isObj(schema.properties)) {
    for (const [name, prop] of Object.entries(schema.properties)) {
      const resolved = deref(spec, prop);
      out.push({
        name,
        type: typeLabel(spec, prop),
        required: required.has(name),
        description: str(isObj(prop) ? prop.description : null) ?? str(resolved?.description),
      });
    }
  }
  const byName = new Map<string, FieldView>();
  for (const f of out)
    byName.set(f.name, {
      ...f,
      required: f.required || required.has(f.name) || byName.get(f.name)?.required === true,
    });
  return [...byName.values()];
}

/** A body's or a response's schema: its label, and its fields (an array's items' fields). */
export function schemaView(spec: Obj, schema: unknown): SchemaView | null {
  if (!isObj(schema)) return null;
  const type = typeLabel(spec, schema);
  let target = deref(spec, schema);
  if (target?.type === 'array') target = deref(spec, target.items);
  return {
    type,
    description: str(deref(spec, schema)?.description),
    fields: fieldsOf(spec, target),
  };
}

const jsonContent = (
  spec: Obj,
  content: unknown,
): { contentType: string; schema: unknown } | null => {
  if (!isObj(content)) return null;
  const type = Object.keys(content).find((k) => k.includes('json')) ?? Object.keys(content)[0];
  if (!type) return null;
  const media = deref(spec, content[type]);
  return { contentType: type, schema: media?.schema };
};

function securityOf(spec: Obj, op: Obj): string[] {
  const reqs = Array.isArray(op.security)
    ? op.security
    : Array.isArray(spec.security)
      ? spec.security
      : [];
  const names = new Set<string>();
  for (const r of reqs) if (isObj(r)) for (const k of Object.keys(r)) names.add(k);
  return [...names];
}

/** The document flattened for the page, or null when it is not an OpenAPI 3 document. */
export function flattenSpec(input: unknown): SpecView | null {
  if (!isObj(input) || typeof input.openapi !== 'string' || !isObj(input.paths)) return null;
  const spec = input;
  const info = isObj(spec.info) ? spec.info : {};
  const tagOrder = (Array.isArray(spec.tags) ? spec.tags : [])
    .filter(isObj)
    .map((t) => ({ name: String(t.name), description: str(t.description) }));
  const groups = new Map<string | null, GroupView>();
  for (const t of tagOrder)
    groups.set(t.name, { tag: t.name, description: t.description, operations: [] });
  let count = 0;
  for (const [path, rawItem] of Object.entries(spec.paths as Obj)) {
    const item = deref(spec, rawItem);
    if (!item) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = deref(spec, item[method]);
      if (!op) continue;
      const params = new Map<string, ParamView>();
      for (const p of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const param = deref(spec, p);
        if (!param || typeof param.name !== 'string') continue;
        const where = String(param.in ?? 'query');
        params.set(`${where}:${param.name}`, {
          name: param.name,
          in: where,
          required: param.required === true || where === 'path',
          type: typeLabel(spec, param.schema),
          description: str(param.description),
        });
      }
      const body = deref(spec, op.requestBody);
      const bodyContent = body ? jsonContent(spec, body.content) : null;
      const bodySchema = bodyContent ? schemaView(spec, bodyContent.schema) : null;
      const responses: ResponseView[] = Object.entries(isObj(op.responses) ? op.responses : {})
        .map(([code, r]) => {
          const res = deref(spec, r);
          const content = res ? jsonContent(spec, res.content) : null;
          return {
            code,
            description: str(res?.description),
            schema: content ? schemaView(spec, content.schema) : null,
          };
        })
        .sort((a, b) => a.code.localeCompare(b.code));
      const view: OperationView = {
        id: str(op.operationId) ?? `${method}-${path}`,
        method,
        path,
        summary: str(op.summary),
        description: str(op.description),
        deprecated: op.deprecated === true,
        params: [...params.values()],
        body:
          bodySchema && bodyContent
            ? {
                contentType: bodyContent.contentType,
                required: body?.required === true,
                schema: bodySchema,
              }
            : null,
        responses,
        security: securityOf(spec, op),
      };
      const tag = Array.isArray(op.tags) && typeof op.tags[0] === 'string' ? op.tags[0] : null;
      if (!groups.has(tag)) groups.set(tag, { tag, description: null, operations: [] });
      groups.get(tag)!.operations.push(view);
      count++;
    }
  }
  return {
    title: str(info.title),
    version: str(info.version),
    description: str(info.description),
    groups: [...groups.values()].filter((g) => g.operations.length > 0),
    count,
  };
}

/** Whether an operation matches a search (its path, summary or method). */
export function matchesQuery(op: OperationView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [op.method, op.path, op.summary ?? '', op.id].some((s) => s.toLowerCase().includes(q));
}
