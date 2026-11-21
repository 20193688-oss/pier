import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

const DESCRIPTION = `A peer-to-peer market for stablecoins against local money.

Credentials:
- **API keys** (\`Authorization: Bearer pk_live_...\` / \`pk_test_...\`) act for one organization on one tier; scopes \`p2p:read\`, \`p2p:write\`.
- **Wallet sessions** (Sign-In with Ethereum, \`/v1/auth/*\`): an HttpOnly cookie for browsers, or \`Authorization: Bearer ps_sess_...\`. Members act for an organization with the \`Pier-Organization\` and \`Pier-Tier\` headers.
- The market overview, sign-in and the hosted charge's payer routes (\`/v1/p2p-checkout/*\`) take no credentials.

Every error is \`{ "error": { "code", "message", "details"? } }\`.

Webhooks are signed: \`pier-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>\`.`;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** `ordersCreate` from `OrdersController.create`: stable ids the SDK names methods after. */
function operationId(controllerKey: string, methodKey: string): string {
  const base = controllerKey.replace(/Controller$/, '');
  return `${base.charAt(0).toLowerCase()}${base.slice(1)}${methodKey.charAt(0).toUpperCase()}${methodKey.slice(1)}`;
}

/** The OpenAPI document of an app, with keys sorted so a regeneration diffs cleanly. */
export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Pier API')
    .setDescription(DESCRIPTION)
    .setVersion('0.1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        description:
          'An API key (`pk_live_...`, `pk_test_...`) or a session token (`ps_sess_...`).',
      },
      'bearer',
    )
    .addCookieAuth(
      'pier_session',
      { type: 'apiKey', in: 'cookie', name: 'pier_session' },
      'session',
    )
    .build();
  const document = SwaggerModule.createDocument(app, config, { operationIdFactory: operationId });
  return sortKeys(document) as OpenAPIObject;
}
