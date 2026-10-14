import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CARE_DASHBOARD_URI, UI_MIME_TYPE } from '../src/mcp/apps.js';
import { call, connect, startServer } from './helpers.js';

let srv: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  srv = await startServer();
});
afterAll(async () => {
  await srv.stop();
});

type UiMeta = { ui?: { resourceUri?: string; visibility?: string[] } };

describe('MCP Apps', () => {
  it('links get_care_status to the dashboard and limits what the app can call', async () => {
    const c = await connect(srv.url, 'rose');
    const { tools } = await c.listTools();
    const meta = Object.fromEntries(tools.map(t => [t.name, (t._meta ?? {}) as UiMeta]));
    expect(meta.get_care_status.ui?.resourceUri).toBe(CARE_DASHBOARD_URI);
    for (const t of tools) expect(meta[t.name].ui?.visibility, t.name).toContain('model');
    const appVisible = tools.filter(t => meta[t.name].ui?.visibility?.includes('app')).map(t => t.name).sort();
    expect(appVisible).toEqual(['get_care_status', 'log_medication']);
    expect(meta.request_refill.ui?.visibility).toEqual(['model']);
    await c.close();
  });

  it('serves a self-contained dashboard as text/html;profile=mcp-app', async () => {
    const c = await connect(srv.url, 'maya');
    const { resources } = await c.listResources();
    expect(resources.find(r => r.uri === CARE_DASHBOARD_URI)?.mimeType).toBe(UI_MIME_TYPE);
    const { contents } = await c.readResource({ uri: CARE_DASHBOARD_URI });
    expect(contents).toHaveLength(1);
    const page = contents[0] as { mimeType: string; text: string; _meta?: { ui?: { csp?: Record<string, string[]> } } };
    expect(page.mimeType).toBe(UI_MIME_TYPE);
    expect(page.text).toMatch(/^<!doctype html>/i);
    expect(page.text).toContain("'ui/initialize'");
    expect(page.text).toContain("name: 'log_medication'");
    // No external scripts, styles, fonts or fetches: the host's default CSP blocks them anyway.
    expect(page.text).not.toMatch(/<script[^>]+src=|<link[^>]+href=|fetch\(|XMLHttpRequest|https?:\/\/(?!www\.w3\.org)/);
    expect(page._meta?.ui?.csp).toEqual({ connectDomains: [], resourceDomains: [] });
    await c.close();
  });

  it('tells the view whether the status is for today', async () => {
    const c = await connect(srv.url, 'rose');
    expect((await call(c, 'get_care_status')).structuredContent?.isToday).toBe(true);
    expect((await call(c, 'get_care_status', { date: '2026-10-09' })).structuredContent?.isToday).toBe(false);
    await c.close();
  });
});
