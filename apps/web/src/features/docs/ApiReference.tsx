/* The API reference, drawn from the API's OpenAPI document (apps/api/openapi.json, loaded at build
   time as `virtual:openapi`). Each route is a disclosure: method, path and summary on its line;
   parameters, body fields, responses and who may call it inside. Without the document, the routes
   the web app calls, grouped by area. */
import { useMemo, useState } from 'react';
import spec from 'virtual:openapi';
import { fmt, useT } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { Notice } from '@/components/ui/controls';
import {
  flattenSpec,
  matchesQuery,
  type FieldView,
  type OperationView,
  type SchemaView,
} from '@/features/docs/openapi';
import { ROUTE_GROUPS } from '@/features/docs/route-list';

const METHOD_TONE: Record<string, string> = {
  get: 'bg-info-soft text-info',
  post: 'bg-ok-soft text-ok',
  put: 'bg-warn-soft text-warn',
  patch: 'bg-warn-soft text-warn',
  delete: 'bg-bad-soft text-bad',
};

export function MethodBadge({ method }: { method: string }) {
  const m = method.toLowerCase();
  return (
    <span
      className={`inline-block w-16 shrink-0 rounded-[8px] py-0.5 text-center text-[0.75rem] font-bold uppercase ${METHOD_TONE[m] ?? 'bg-well text-ink-2'}`}
    >
      {m === 'delete' ? 'del' : m}
    </span>
  );
}

function FieldsTable({ fields }: { fields: (FieldView & { in?: string })[] }) {
  const t = useT();
  const r = t.docs.reference;
  const where = r.location as Record<string, string>;
  return (
    <ul className="divide-y divide-line rounded-[12px] border border-line" role="list">
      {fields.map((f) => (
        <li key={`${f.in ?? ''}:${f.name}`} className="flex flex-col gap-1 px-3 py-2.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <code className="text-[0.875rem] font-semibold break-all text-ink">{f.name}</code>
            <span className="text-[0.8125rem] break-all text-ink-3">{f.type}</span>
            {f.in && <span className="text-[0.8125rem] text-ink-3">{where[f.in] ?? f.in}</span>}
            <span
              className={`text-[0.75rem] font-semibold ${f.required ? 'text-warn' : 'text-ink-3'}`}
            >
              {f.required ? r.required : r.optional}
            </span>
          </div>
          {f.description && (
            <p className="m-0 text-[0.875rem] whitespace-pre-line text-ink-2">{f.description}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

function SchemaBlock({ schema }: { schema: SchemaView }) {
  return (
    <div className="flex flex-col gap-2">
      <code className="self-start rounded-md bg-well px-1.5 py-0.5 text-[0.8125rem] break-all">
        {schema.type}
      </code>
      {schema.description && (
        <p className="m-0 text-[0.875rem] whitespace-pre-line text-ink-2">{schema.description}</p>
      )}
      {schema.fields.length > 0 && <FieldsTable fields={schema.fields} />}
    </div>
  );
}

function Operation({ op }: { op: OperationView }) {
  const t = useT();
  const r = t.docs.reference;
  return (
    <details
      className="group rounded-[16px] border border-line bg-sheet open:shadow-[0_1px_0_var(--line)]"
      id={op.id}
    >
      <summary className="flex cursor-pointer list-none items-start gap-3 px-3.5 py-3">
        <MethodBadge method={op.method} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <code className="text-[0.875rem] font-semibold break-all">{op.path}</code>
          {op.summary && <span className="text-[0.875rem] text-ink-2">{op.summary}</span>}
          {op.deprecated && (
            <span className="text-[0.75rem] font-semibold text-warn">{r.deprecated}</span>
          )}
        </span>
        <Icon
          name="chevron"
          size={18}
          className="mt-0.5 shrink-0 text-ink-3 transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="flex flex-col gap-4 border-t border-line px-3.5 py-4">
        {op.description && <p className="m-0 whitespace-pre-line text-ink-2">{op.description}</p>}
        <div>
          <h4 className="mb-1.5 text-[0.9375rem]">{r.auth}</h4>
          <p className="m-0 text-[0.875rem] text-ink-2">
            {op.security.length ? op.security.join(', ') : r.public}
          </p>
        </div>
        {op.params.length > 0 && (
          <div>
            <h4 className="mb-1.5 text-[0.9375rem]">{r.parameters}</h4>
            <FieldsTable fields={op.params} />
          </div>
        )}
        {op.body && (
          <div>
            <h4 className="mb-1.5 text-[0.9375rem]">
              {r.body}{' '}
              <span className="text-[0.8125rem] font-normal text-ink-3">{op.body.contentType}</span>
            </h4>
            <SchemaBlock schema={op.body.schema} />
          </div>
        )}
        {op.responses.length > 0 && (
          <div>
            <h4 className="mb-1.5 text-[0.9375rem]">{r.responses}</h4>
            <ul className="flex flex-col gap-3" role="list">
              {op.responses.map((res) => (
                <li key={res.code} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline gap-2">
                    <code
                      className={`text-[0.875rem] font-bold ${res.code.startsWith('2') ? 'text-ok' : res.code.startsWith('4') || res.code.startsWith('5') ? 'text-bad' : 'text-ink'}`}
                    >
                      {res.code}
                    </code>
                    {res.description && (
                      <span className="text-[0.875rem] text-ink-2">{res.description}</span>
                    )}
                  </div>
                  {res.schema && res.code.startsWith('2') && <SchemaBlock schema={res.schema} />}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

export function ApiReference() {
  const t = useT();
  const r = t.docs.reference;
  const view = useMemo(() => flattenSpec(spec), []);
  const [query, setQuery] = useState('');

  if (!view) {
    return (
      <div className="flex flex-col gap-8">
        <Notice>{r.pending}</Notice>
        {ROUTE_GROUPS.map((g) => (
          <section key={g.key} aria-labelledby={`routes-${g.key}`}>
            <h2 id={`routes-${g.key}`} className="mb-3 text-[1.2rem]">
              {r.groups[g.key]}
            </h2>
            <ul
              className="divide-y divide-line rounded-[16px] border border-line bg-sheet"
              role="list"
            >
              {g.routes.map((route) => (
                <li
                  key={`${route.method} ${route.path}`}
                  className="flex items-center gap-3 px-3.5 py-2.5"
                >
                  <MethodBadge method={route.method} />
                  <code className="min-w-0 text-[0.875rem] break-all">{route.path}</code>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }

  const groups = view.groups
    .map((g) => ({ ...g, operations: g.operations.filter((op) => matchesQuery(op, query)) }))
    .filter((g) => g.operations.length > 0);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <p className="m-0 text-[0.9375rem] text-ink-3">
          {[
            view.title,
            view.version ? fmt(r.version, { version: view.version }) : null,
            fmt(r.operations, { n: view.count }),
          ]
            .filter(Boolean)
            .join(', ')}
        </p>
        <div className="relative">
          <Icon
            name="search"
            size={18}
            className="absolute top-1/2 left-3 -translate-y-1/2 text-ink-3"
          />
          <input
            type="search"
            className="field pl-10"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={r.search}
            aria-label={r.search}
          />
        </div>
      </div>
      {groups.length === 0 && <p className="text-ink-3">{r.noResults}</p>}
      {groups.map((g) => (
        <section key={g.tag ?? 'other'} aria-labelledby={`tag-${g.tag ?? 'other'}`}>
          <h2 id={`tag-${g.tag ?? 'other'}`} className="mb-1 text-[1.2rem]">
            {g.tag ?? r.other}
          </h2>
          {g.description && (
            <p className="mb-3 text-[0.9375rem] whitespace-pre-line text-ink-2">{g.description}</p>
          )}
          <div className="mt-3 flex flex-col gap-2">
            {g.operations.map((op) => (
              <Operation key={`${op.method} ${op.path}`} op={op} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
