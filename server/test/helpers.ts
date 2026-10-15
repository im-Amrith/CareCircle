import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client, StreamableHTTPClientTransport, type ClientCapabilities } from '@modelcontextprotocol/client';
import { loadConfig, makeClock } from '../src/config.js';
import { buildSeededStore, readSeedFile } from '../src/store/seed.js';
import { createHttpApp } from '../src/http/app.js';

export const SEED = resolve(import.meta.dirname, '../../seed/rose.json');
/** 09:00 in Asia/Kolkata: morning doses are due, evening and night are upcoming. */
export const NINE_AM_IST = '2026-10-10T03:30:00Z';

export function seededStore(nowIso = NINE_AM_IST) {
  return buildSeededStore(readSeedFile(SEED), new Date(nowIso));
}

export async function startServer(nowIso = NINE_AM_IST) {
  const config = { ...loadConfig({}), port: 0, fixedNow: nowIso, seedPath: SEED };
  const clock = makeClock(nowIso);
  const store = seededStore(nowIso);
  const { app, close, sessions, deps } = createHttpApp(config, { store, clock, defaultUser: config.defaultUser });
  const server: Server = await new Promise(res => {
    const s = app.listen(0, '127.0.0.1', () => res(s));
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/mcp`;
  return {
    url,
    store,
    sessions,
    /** The deps the server runs with: its store wrapper announces every write. */
    deps,
    async stop() {
      await close();
      await new Promise(res => server.close(res));
    }
  };
}

export async function connect(url: string, user: string, setup?: (client: Client) => void, capabilities?: ClientCapabilities) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer dev:${user}` } }
  });
  const client = new Client({ name: 'carecircle-tests', version: '0.0.1' }, capabilities ? { capabilities } : undefined);
  setup?.(client);
  await client.connect(transport);
  return client;
}

export type ToolResult = {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, any>;
  isError?: boolean;
};

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

export function said(r: ToolResult): string {
  return r.content.find(c => c.type === 'text')?.text ?? '';
}
