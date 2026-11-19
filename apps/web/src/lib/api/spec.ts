/* The API's own types (src/lib/api/openapi.gen.ts, generated from apps/api/openapi.json by
   `npm run gen:api`), used to check every request body the web app sends against its schema:
   `body('CreateOfferDto', {...})` fails to compile on a misnamed, missing or extra field. Enum
   fields are relaxed to strings, because their values come from the market at run time and the
   API validates them. */
import type { components } from '@/lib/api/openapi.gen';

export type Schemas = components['schemas'];

type Loose<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends readonly (infer U)[]
        ? Loose<U>[]
        : T extends object
          ? { [K in keyof T]: Loose<T[K]> }
          : T;

/** The body schema `name` accepts, enums relaxed to strings. */
export type Body<N extends keyof Schemas> = Loose<Schemas[N]>;

/** A request body checked against the API schema `name`. */
export const body = <N extends keyof Schemas>(_name: N, value: Loose<Schemas[N]>) => value;
