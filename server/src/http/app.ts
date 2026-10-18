import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isInitializeRequest, LATEST_PROTOCOL_VERSION, type McpServer } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import type { Deps } from '../mcp/context.js';
import { createCareCircleServer, SERVER_NAME, SERVER_VERSION } from '../mcp/server.js';
import { devAuth, userOf } from './auth.js';
import { MemoryEventStore } from './event-store.js';
import { checkoutRouter } from './checkout.js';
import { ChangeHub, watchStore } from '../store/changes.js';
import { createNotifier, snsPublisher } from '../notify/notifier.js';
import { runDigestSchedule } from '../notify/digest.js';

interface Session {
  transport: NodeStreamableHTTPServerTransport;
  server: McpServer;
  userId: string;
  lastSeen: number;
}

function rpcError(res: Response, status: number, code: number, message: string) {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * Streamable HTTP on a single /mcp endpoint (MCP 2025-11-25):
 * POST for client messages, GET for the server-to-client SSE stream, DELETE to end a session.
 * Stateful: one McpServer + transport per session, so elicitation, progress and tasks work.
 * Host and Origin validation come from createMcpExpressApp (403 on mismatch);
 * the transport rejects unsupported MCP-Protocol-Version headers with 400.
 */
export function createHttpApp(config: Config, baseDeps: Deps) {
  // Every write is announced on the hub, so each family member's session can push updates.
  const changes = baseDeps.changes ?? new ChangeHub();
  const store = watchStore(baseDeps.store, changes);
  const deps: Deps = {
    ...baseDeps,
    store,
    changes,
    notifier: baseDeps.notifier ?? createNotifier(store, config.snsTopicArn ? snsPublisher(config.snsTopicArn, config.awsRegion) : undefined),
    publicUrl: baseDeps.publicUrl ?? config.publicUrl,
    checkoutWatchers: baseDeps.checkoutWatchers ?? new Map()
  };
  const app = createMcpExpressApp({
    host: config.host,
    ...(config.allowedHosts ? { allowedHosts: config.allowedHosts } : {}),
    ...(config.allowedOrigins ? { allowedOrigins: config.allowedOrigins } : {})
  });
  const sessions = new Map<string, Session>();

  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      name: SERVER_NAME,
      version: SERVER_VERSION,
      protocol: LATEST_PROTOCOL_VERSION,
      sessions: sessions.size,
      eveningSummary: { at: config.digestTime ?? 'off', sns: Boolean(config.snsTopicArn) }
    });
  });

  // Refill checkout pages. Not behind dev auth: the one-time link is the credential.
  app.use(checkoutRouter(deps));

  app.use('/mcp', devAuth(config));

  /** Finds the caller's session; answers 400/404/403 itself and returns undefined when it can't. */
  function sessionFor(req: Request, res: Response): Session | undefined {
    const sid = req.header('mcp-session-id');
    if (!sid) {
      rpcError(res, 400, -32000, 'Bad Request: missing MCP-Session-Id header');
      return undefined;
    }
    const session = sessions.get(sid);
    if (!session) {
      rpcError(res, 404, -32001, 'Session not found');
      return undefined;
    }
    if (session.userId !== userOf(req)) {
      // A session id is bound to the identity that created it.
      rpcError(res, 403, -32003, 'Session belongs to a different user');
      return undefined;
    }
    session.lastSeen = Date.now();
    return session;
  }

  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      if (req.header('mcp-session-id')) {
        const session = sessionFor(req, res);
        if (session) await session.transport.handleRequest(req, res, req.body);
        return;
      }
      if (!isInitializeRequest(req.body)) {
        rpcError(res, 400, -32000, 'Bad Request: send initialize first, or include MCP-Session-Id');
        return;
      }
      const userId = userOf(req) ?? config.defaultUser;
      const server = createCareCircleServer(deps);
      const transport: NodeStreamableHTTPServerTransport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore: new MemoryEventStore(),
        onsessioninitialized: sid => {
          sessions.set(sid, { transport, server, userId, lastSeen: Date.now() });
        },
        onsessionclosed: sid => {
          sessions.delete(sid);
        }
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[carecircle] POST /mcp failed', err);
      if (!res.headersSent) rpcError(res, 500, -32603, 'Internal server error');
    }
  });

  const streamOrEnd = async (req: Request, res: Response) => {
    try {
      const session = sessionFor(req, res);
      if (session) await session.transport.handleRequest(req, res);
    } catch (err) {
      console.error(`[carecircle] ${req.method} /mcp failed`, err);
      if (!res.headersSent) rpcError(res, 500, -32603, 'Internal server error');
    }
  };
  app.get('/mcp', streamOrEnd);
  app.delete('/mcp', streamOrEnd);

  // Drop sessions idle for longer than the configured window.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - config.sessionIdleMinutes * 60_000;
    for (const [sid, s] of sessions) {
      if (s.lastSeen < cutoff) {
        sessions.delete(sid);
        void s.transport.close().catch(() => undefined);
      }
    }
  }, 60_000);
  sweep.unref();

  // The evening summary: checked every minute, sent once per family per day at its digest time.
  const digest = config.digestTime
    ? setInterval(() => {
        runDigestSchedule(deps, config.digestTime).catch(err => console.error('[carecircle] evening summary failed', err));
      }, 60_000)
    : undefined;
  digest?.unref();

  async function close() {
    clearInterval(sweep);
    if (digest) clearInterval(digest);
    await Promise.all([...sessions.values()].map(s => s.transport.close().catch(() => undefined)));
    sessions.clear();
  }

  return { app, sessions, close, deps };
}
