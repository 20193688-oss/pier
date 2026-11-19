import { describe, expect, it } from 'vitest';
import { createPedospeClient, PedospeError, unwrap } from '@/client';

const baseUrl = 'https://api.pedospe.test';
const apiKey = 'pk_test_3kQ9x7Lm2Vb8';
const sessionToken = 'ps_sess_Zr4f8Ty1Qw6e';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A `fetch` that records each request and answers the given responses in turn. */
function fakeFetch(...responses: Response[]) {
  const requests: Request[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    requests.push(request);
    const response = responses.shift();
    if (!response) throw new Error('unexpected request');
    return response;
  };
  return { fetch, requests };
}

describe('createPedospeClient', () => {
  it('sends an API key as a bearer token and no session headers', async () => {
    const { fetch, requests } = fakeFetch(json(200, { available: true }));
    const client = createPedospeClient({ baseUrl, apiKey, fetch });
    await client.GET('/v1/market');

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].url).toBe(`${baseUrl}/v1/market`);
    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${apiKey}`);
    expect(requests[0].headers.has('pedospe-organization')).toBe(false);
    expect(requests[0].headers.has('pedospe-tier')).toBe(false);
  });

  it('sends a session token with the organization and tier to act for', async () => {
    const { fetch, requests } = fakeFetch(json(200, { data: [], total: 0 }));
    const client = createPedospeClient({
      baseUrl: `${baseUrl}/`,
      sessionToken,
      organizationId: 'org_42',
      tier: 'live',
      fetch,
    });
    await client.GET('/v1/p2p/orders', { params: { query: { take: 5 } } });

    const [request] = requests;
    expect(request.url).toBe(`${baseUrl}/v1/p2p/orders?take=5`);
    expect(request.headers.get('authorization')).toBe(`Bearer ${sessionToken}`);
    expect(request.headers.get('pedospe-organization')).toBe('org_42');
    expect(request.headers.get('pedospe-tier')).toBe('live');
  });

  it('posts JSON bodies', async () => {
    const { fetch, requests } = fakeFetch(json(200, { data: [] }));
    const client = createPedospeClient({ baseUrl, apiKey, fetch });
    const body = { currency: 'ARS' as const, amount: '125050.00', payerName: 'Juan Gómez' };
    const result = await unwrap(client.POST('/v1/p2p/merchant/transfer-matches', { body }));

    expect(result).toEqual({ data: [] });
    expect(requests[0].method).toBe('POST');
    expect(requests[0].headers.get('content-type')).toBe('application/json');
    expect(await requests[0].json()).toEqual(body);
  });

  it('calls public routes without credentials', async () => {
    const { fetch, requests } = fakeFetch(json(200, { available: true }));
    await createPedospeClient({ baseUrl, fetch }).GET('/v1/market');
    expect(requests[0].headers.has('authorization')).toBe(false);
  });

  it('rejects contradictory or malformed credentials without echoing them', () => {
    expect(() => createPedospeClient({ baseUrl, apiKey, sessionToken })).toThrow(/either/);
    expect(() => createPedospeClient({ baseUrl, apiKey, organizationId: 'org_42' })).toThrow(
      /sessions/,
    );
    expect(() => createPedospeClient({ baseUrl, apiKey, tier: 'live' })).toThrow(/sessions/);
    expect(() => createPedospeClient({ baseUrl: 'api.pedospe.test', apiKey })).toThrow(/baseUrl/);
    expect(() => createPedospeClient({ baseUrl, apiKey: sessionToken })).toThrow(TypeError);
    expect(() => createPedospeClient({ baseUrl, sessionToken: apiKey })).toThrow(TypeError);
    try {
      createPedospeClient({ baseUrl, apiKey: 'sk_secret_value' });
    } catch (error) {
      expect((error as Error).message).not.toContain('sk_secret_value');
    }
  });
});

describe('unwrap', () => {
  it('returns the success body', async () => {
    const { fetch } = fakeFetch(json(200, { available: true, tier: 'test' }));
    const client = createPedospeClient({ baseUrl, fetch });
    const market = await unwrap(client.GET('/v1/market'));
    expect(market).toEqual({ available: true, tier: 'test' });
  });

  it('accepts an already awaited result', async () => {
    const { fetch } = fakeFetch(json(200, { available: true }));
    const client = createPedospeClient({ baseUrl, fetch });
    const result = await client.GET('/v1/market');
    expect(await unwrap(result)).toEqual({ available: true });
  });

  it('throws a PedospeError with the API error code, message and details', async () => {
    const { fetch } = fakeFetch(
      json(400, {
        error: {
          code: 'validation_failed',
          message: 'The request is not valid.',
          details: ['amount must be a positive decimal'],
        },
      }),
    );
    const client = createPedospeClient({ baseUrl, apiKey, fetch });
    const call = unwrap(
      client.POST('/v1/p2p/merchant/transfer-matches', {
        body: { currency: 'ARS', amount: '-1' },
      }),
    );
    await expect(call).rejects.toBeInstanceOf(PedospeError);
    await expect(call).rejects.toMatchObject({
      name: 'PedospeError',
      status: 400,
      code: 'validation_failed',
      message: 'The request is not valid.',
      details: ['amount must be a positive decimal'],
    });
  });

  it('throws on auth errors too', async () => {
    const { fetch } = fakeFetch(
      json(401, { error: { code: 'unauthorized', message: 'This API key is not valid.' } }),
    );
    const client = createPedospeClient({ baseUrl, apiKey, fetch });
    const error = await unwrap(client.GET('/v1/p2p/orders')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PedospeError);
    expect(error).toMatchObject({ status: 401, code: 'unauthorized' });
    expect((error as PedospeError).details).toBeUndefined();
  });

  it('reports a response without the error body as unexpected', async () => {
    const { fetch } = fakeFetch(new Response('<html>Bad gateway</html>', { status: 502 }));
    const client = createPedospeClient({ baseUrl, fetch });
    await expect(unwrap(client.GET('/v1/market'))).rejects.toMatchObject({
      status: 502,
      code: 'unexpected_response',
    });
  });

  it('returns undefined for a 204', async () => {
    const { fetch, requests } = fakeFetch(new Response(null, { status: 204 }));
    const client = createPedospeClient({ baseUrl, apiKey, fetch });
    const result = await unwrap(
      client.DELETE('/v1/webhook-endpoints/{id}', { params: { path: { id: 'we_1' } } }),
    );
    expect(result).toBeUndefined();
    expect(requests[0].method).toBe('DELETE');
    expect(requests[0].url).toBe(`${baseUrl}/v1/webhook-endpoints/we_1`);
  });
});
