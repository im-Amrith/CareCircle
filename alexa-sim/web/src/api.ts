/** Talks to the orchestrator through the Vite proxy (/api). The browser never talks MCP directly. */

export type ProfileId = 'rose' | 'sam' | 'maya';

export interface RpcEntry {
  seq: number;
  profile: ProfileId;
  dir: 'out' | 'in';
  kind: 'request' | 'response' | 'notification' | 'error';
  method: string | null;
  id: string | number | null;
  ms: number | null;
  t: number;
  body: unknown;
  note?: string;
}

export interface ToolCall {
  id: string | number;
  name: string;
  arguments: Record<string, unknown>;
  invoking?: string;
}

export interface ToolResult {
  id: string | number;
  name: string;
  text: string;
  structuredContent: Record<string, any>;
  isError: boolean;
  uiResourceUri?: string;
}

export interface UiResource {
  uri: string;
  html: string;
  csp: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[]; baseUriDomains?: string[] };
  prefersBorder?: boolean | null;
}

export interface JsonSchemaProp {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  oneOf?: { const: string; title?: string }[];
  minimum?: number;
  maximum?: number;
}

export interface Elicitation {
  id: string;
  mode: 'form' | 'url';
  message: string;
  requestedSchema?: { type: 'object'; properties: Record<string, JsonSchemaProp>; required?: string[] };
  url?: string;
  elicitationId?: string;
}

export interface Speech {
  text: string;
  audio?: string;
  format?: string;
  voice?: string;
}

export interface Warning {
  source: 'bedrock' | 'polly' | string;
  message: string;
}

export type TurnEvent =
  | { type: 'transcript'; data: { profile: ProfileId; text: string } }
  | { type: 'tool_call'; data: ToolCall }
  | { type: 'tool_result'; data: ToolResult }
  | { type: 'elicitation'; data: Elicitation }
  | { type: 'speech'; data: Speech }
  | { type: 'warning'; data: Warning }
  | { type: 'rpc'; data: RpcEntry }
  | { type: 'done'; data: Record<string, never> }
  | { type: 'error'; data: { message: string } };

export interface Health {
  ok: boolean;
  mcp: { reachable: boolean; url: string; protocol?: string; error?: string };
  brain: { mode: 'mock' | 'bedrock'; reason?: string; model?: string; region?: string };
  speech: { mode: 'polly' | 'browser'; voice: string | null; detail: string };
  /** The MCP Apps sandbox proxy, on the orchestrator's own origin. */
  sandboxUrl?: string;
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return typeof body.detail === 'string' ? body.detail : JSON.stringify(body);
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

/** POST /turn and feed each SSE event to `onEvent` until the stream ends. */
export async function streamTurn(profile: ProfileId, text: string, onEvent: (e: TurnEvent) => void, signal?: AbortSignal) {
  const res = await fetch('/api/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ profile, text }),
    signal
  });
  if (!res.ok || !res.body) throw new Error(await errorText(res));
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value.replace(/\r\n/g, '\n');
    let cut: number;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let type = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) type = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      if (data.length) onEvent({ type, data: JSON.parse(data.join('\n')) } as TurnEvent);
    }
  }
}

export async function answerElicitation(id: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) {
  const res = await fetch(`/api/elicitation/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...(content ? { content } : {}) })
  });
  if (!res.ok) throw new Error(await errorText(res));
}

export async function connectProfile(profile: ProfileId): Promise<void> {
  const res = await fetch(`/api/profiles/${profile}/connect`, { method: 'POST' });
  if (!res.ok) throw new Error(await errorText(res));
}

export async function resetProfile(profile: ProfileId): Promise<void> {
  await fetch(`/api/profiles/${profile}/reset`, { method: 'POST' });
}

export async function fetchRpc(profile: ProfileId, after: number): Promise<RpcEntry[]> {
  const res = await fetch(`/api/rpc?profile=${profile}&after=${after}`);
  if (!res.ok) return [];
  return (await res.json()).entries as RpcEntry[];
}

/** An MCP App view (`ui://` resource), read once per session by the orchestrator. */
export async function fetchUiResource(profile: ProfileId, uri: string): Promise<UiResource> {
  const res = await fetch(`/api/profiles/${profile}/ui-resource?uri=${encodeURIComponent(uri)}`);
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()) as UiResource;
}

/** A view's tools/call. The orchestrator refuses tools that aren't visible to apps. */
export async function appToolCall(profile: ProfileId, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/profiles/${profile}/app/tools/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, arguments: args })
  });
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()) as Record<string, unknown>;
}

export async function fetchHealth(): Promise<Health | null> {
  try {
    const res = await fetch('/api/healthz');
    return res.ok ? ((await res.json()) as Health) : null;
  } catch {
    return null;
  }
}
