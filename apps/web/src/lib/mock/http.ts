/* The mock API's small HTTP vocabulary: answers in the API's shapes and error format. */
import type { ApiRequest, ApiResponse } from '@/lib/api/client';
import { db, pub, type Wire } from '@/lib/mock/db';

export type Handler = (ctx: Ctx) => ApiResponse | Promise<ApiResponse>;
export interface Ctx {
  req: ApiRequest;
  params: Record<string, string>;
  body: Wire;
  header: (name: string) => string | undefined;
}

export const ok = (json: unknown, status = 200): ApiResponse => ({ status, json });
export const none = (): ApiResponse => ({ status: 204, json: null });
export const fail = (status: number, code: string, message: string): ApiResponse => ({
  status,
  json: { error: { code, message } },
});
export const list = (items: Wire[]) => ok({ data: items.map(pub) });
export const byNewest = (a: Wire, b: Wire) =>
  String(b.createdAt).localeCompare(String(a.createdAt));

export function session() {
  return db().session;
}
