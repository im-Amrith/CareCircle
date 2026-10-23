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
import { voiceCheckRouter } from './voice-check.js';
import { ChangeHub, watchStore } from '../store/changes.js';
import { createNotifier, snsPublisher } from '../notify/notifier.js';
import { runDigestSchedule } from '../notify/digest.js';
import { runCheckInSchedule } from '../mcp/checkins.js';
import { mockAppointmentServices } from '../domain/appointments.js';
import { RemotePlanner } from '../domain/remote-planner.js';
import { localParts, toMinutes } from '../domain/time.js';

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
    checkoutWatchers: baseDeps.checkoutWatchers ?? new Map(),
    voiceChecks: baseDeps.voiceChecks ?? new Map(),
    // Appointment planning by the orchestrator's Strands care team when configured; locally otherwise.
    appointmentPlanner: baseDeps.appointmentPlanner ?? (config.plannerUrl ? new RemotePlanner(mockAppointmentServices(), config.plannerUrl) : undefined)
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
  // "Was this you?" phone confirmations for unsure voice matches. Same model: the one-time link is the credential.
  app.use(voiceCheckRouter(deps));

  app.use('/mcp', devAuth(config));

  // Demo only: a frozen clock can be moved forward ("skip ahead 30 minutes") to show what
  // happens later in the morning. Absent with a real clock, so it can never change real time.
  if (config.fixedNow && deps.clock.advance) {
    app.post('/dev/clock', async (req: Request, res: Response) => {
      // ?minutes=30, or ?to=08:30 for the next time it is 8:30 am in the family's timezone.
      let minutes = Number((req.query.minutes as string | undefined) ?? 0);
      const to = req.query.to as string | undefined;
      if (to !== undefined) {
        const family = (await deps.store.listFamilies())[0];
        if (!/^\d{2}:\d{2}$/.test(to) || !family) {
          res.status(400).json({ error: 'to must be HH:MM' });
          return;
        }
        const nowMin = localParts(deps.clock(), family.timezone).minutes;
        minutes = ((toMinutes(to) - nowMin + 1440) % 1440) || 1440;
      }
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
        res.status(400).json({ error: 'minutes must be between 1 and 1440' });
        return;
      }
      const now = deps.clock.advance!(minutes * 60_000);
      for (const family of await deps.store.listFamilies()) changes.emit({ familyId: family.id, kind: 'clock' });
      await runCheckInSchedule(deps).catch(err => console.error('[carecircle] check-in failed', err));
      if (config.digestTime) await runDigestSchedule(deps, config.digestTime).catch(err => console.error('[carecircle] evening summary failed', err));
      res.json({ now: now.toISOString() });
    });
  }

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

  // Morning check-ins: checked every minute; a quiet morning gets a check-in, then the family.
  const checkIns = setInterval(() => {
    runCheckInSchedule(deps).catch(err => console.error('[carecircle] check-in failed', err));
  }, 60_000);
  checkIns.unref();

  async function close() {
    clearInterval(sweep);
    if (digest) clearInterval(digest);
    clearInterval(checkIns);
    await Promise.all([...sessions.values()].map(s => s.transport.close().catch(() => undefined)));
    sessions.clear();
  }

  return { app, sessions, close, deps };
}
