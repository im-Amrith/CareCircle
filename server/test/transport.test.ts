/**
 * Streamable HTTP conformance checks against the raw endpoint (MCP 2025-11-25):
 * session rules, version header, Origin validation, Accept header, auth binding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from './helpers.js';

let srv: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  srv = await startServer();
});
afterAll(async () => {
  await srv.stop();
});

const ACCEPT = 'application/json, text/event-stream';
const init = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } }
};

async function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(srv.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT, ...headers },
    body: JSON.stringify(body)
  });
}

async function openSession(user = 'sam') {
  const res = await post(init, { authorization: `Bearer dev:${user}` });
  expect(res.status).toBe(200);
  const sid = res.headers.get('mcp-session-id');
  expect(sid).toMatch(/^[\x21-\x7e]+$/);
  await res.text();
  const ack = await post(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { authorization: `Bearer dev:${user}`, 'mcp-session-id': sid!, 'mcp-protocol-version': '2025-11-25' }
  );
  expect(ack.status).toBe(202);
  return sid!;
}

describe('Streamable HTTP transport', () => {
  it('issues a session id on initialize and answers in-session requests', async () => {
    const sid = await openSession();
    const res = await post(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' }
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('get_care_status');
  });

  it('rejects non-initialize requests without a session id (400)', async () => {
    const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown session id', async () => {
    const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': 'does-not-exist' });
    expect(res.status).toBe(404);
  });

  it('rejects an unsupported MCP-Protocol-Version header (400)', async () => {
    const sid = await openSession();
    const res = await post(
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { 'mcp-session-id': sid, 'mcp-protocol-version': '1999-01-01' }
    );
    expect(res.status).toBe(400);
  });

  it('rejects a foreign Origin (403) and allows localhost origins', async () => {
    const bad = await post(init, { origin: 'https://evil.example' });
    expect(bad.status).toBe(403);
    const good = await post(init, { origin: 'http://localhost:5173' });
    expect(good.status).toBe(200);
    await good.text();
  });

  it('requires the Accept header to list both JSON and SSE', async () => {
    const res = await fetch(srv.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(init)
    });
    expect(res.status).toBe(406);
  });

  it('ends a session on DELETE; the id then returns 404', async () => {
    const sid = await openSession();
    const del = await fetch(srv.url, { method: 'DELETE', headers: { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' } });
    expect(del.status).toBe(200);
    const after = await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' });
    expect(after.status).toBe(404);
  });

  it('binds a session to the user who opened it (403 for anyone else)', async () => {
    const sid = await openSession('rose');
    const res = await post(
      { jsonrpc: '2.0', id: 5, method: 'tools/list' },
      { authorization: 'Bearer dev:sam', 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' }
    );
    expect(res.status).toBe(403);
  });

  it('rejects malformed bearer tokens with 401 and WWW-Authenticate', async () => {
    const res = await post(init, { authorization: 'Bearer not-a-dev-token' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('opens a server-to-client SSE stream on GET', async () => {
    const sid = await openSession();
    const ctrl = new AbortController();
    const res = await fetch(srv.url, {
      method: 'GET',
      headers: { accept: 'text/event-stream', 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' },
      signal: ctrl.signal
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    ctrl.abort();
  });

  it('serves a health check', async () => {
    const res = await fetch(srv.url.replace('/mcp', '/healthz'));
    expect(await res.json()).toMatchObject({ ok: true, protocol: '2025-11-25' });
  });
});
