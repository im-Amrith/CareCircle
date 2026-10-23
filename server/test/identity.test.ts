import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport, type ClientCapabilities } from '@modelcontextprotocol/client';
import { TOOL_KINDS, describeAttempt } from '../src/mcp/identity.js';
import { callerFor } from '../src/mcp/context.js';
import { call, said, startServer, type ToolResult } from './helpers.js';

type Confidence = 'high' | 'low' | 'unknown';
type Asked = { mode?: string; message: string; url?: string; elicitationId?: string; requestedSchema?: any };

/**
 * A client on a shared device: every request carries the voice match the test sets.
 * `answer` handles elicitations; by default it declines anything that isn't "who's speaking".
 */
async function device(
  url: string,
  user: string,
  opts: { caps?: ClientCapabilities; answer?: (asked: Asked) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }> } = {}
) {
  const voice: { confidence: Confidence; candidates: string } = { confidence: 'high', candidates: '' };
  const asked: Asked[] = [];
  const completed: string[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer dev:${user}` } },
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('X-Speaker-Confidence', voice.confidence);
      if (voice.candidates) headers.set('X-Speaker-Candidates', voice.candidates);
      return fetch(input, { ...init, headers });
    }
  });
  const client = new Client({ name: 'shared-device-tests', version: '0.0.1' }, opts.caps ? { capabilities: opts.caps } : undefined);
  if (opts.caps?.elicitation) {
    client.setRequestHandler('elicitation/create', async req => {
      asked.push(req.params as Asked);
      if (opts.answer) return opts.answer(req.params as Asked);
      return { action: 'decline' as const };
    });
    client.setNotificationHandler('notifications/elicitation/complete', n => {
      completed.push(n.params.elicitationId);
    });
  }
  await client.connect(transport);
  return {
    client,
    asked,
    completed,
    /** Sets the voice match for the next requests. */
    hears(confidence: Confidence, candidates = '') {
      voice.confidence = confidence;
      voice.candidates = candidates;
    }
  };
}

const isWhoAsk = (a: Asked) => (a.mode ?? 'form') === 'form' && !!a.requestedSchema?.properties?.speaker;
const REFUSED = /I don't recognise this voice/;

/** Valid arguments for every tool, so each can run end to end. */
const ARGS: Record<string, Record<string, unknown>> = {
  get_care_status: {},
  list_medications: {},
  check_refills: {},
  get_morning_rhythm: {},
  log_medication: { spoken_name: 'metformin' },
  log_wellbeing: { note: 'Feeling a bit tired today' },
  request_refill: {},
  coordinate_appointment: { specialty: 'cardiology follow-up', window: 'next week', constraints: 'mornings' },
  set_language: { language: 'en' },
  set_care_preference: { preference: 'Mom prefers mornings' },
  send_daily_summary: {},
  set_check_ins: { action: 'pause', until: 'tomorrow', reason: 'staying with Sam' }
};

describe("Who's speaking? Tool classification", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.stop();
  });

  it('classifies every tool the server offers as read or change, and nothing else', async () => {
    const { client } = await device(srv.url, 'sam');
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    for (const name of names) expect(TOOL_KINDS[name], `classify ${name} in TOOL_KINDS (mcp/identity.ts)`).toMatch(/^(read|change)$/);
    expect(Object.keys(TOOL_KINDS).sort()).toEqual(names);
    expect(Object.keys(ARGS).sort()).toEqual(names);
    await client.close();
  });

  it('reads are exactly the status, medication list, refill check and morning rhythm', () => {
    expect(Object.entries(TOOL_KINDS).filter(([, k]) => k === 'read').map(([n]) => n).sort()).toEqual(['check_refills', 'get_care_status', 'get_morning_rhythm', 'list_medications']);
  });

  it('rejects a confidence it does not know', async () => {
    const res = await fetch(srv.url, {
      method: 'POST',
      headers: { Authorization: 'Bearer dev:sam', 'X-Speaker-Confidence': 'maybe', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    });
    expect(res.status).toBe(400);
  });
});

describe("Who's speaking? Every tool at every confidence", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    srv = await startServer();
  });
  afterEach(async () => {
    await srv.stop();
  });

  // Sam's device. On low, the match was unsure between Sam and Maya; the person says Sam.
  for (const [tool, kind] of Object.entries(TOOL_KINDS)) {
    for (const confidence of ['high', 'low', 'unknown'] as const) {
      it(`${tool} (${kind}) at ${confidence} confidence`, async () => {
        const d = await device(srv.url, 'sam', {
          caps: { elicitation: { form: {}, url: {} } },
          answer: async a => (isWhoAsk(a) ? { action: 'accept', content: { speaker: 'sam' } } : { action: 'decline' })
        });
        d.hears(confidence, 'sam,maya');
        const before = srv.store.voiceChecks.length;
        const r = await call(d.client, tool, ARGS[tool]);
        const whoAsks = d.asked.filter(isWhoAsk);

        if (kind === 'read' || confidence === 'high') {
          expect(whoAsks).toHaveLength(0);
          expect(said(r)).not.toMatch(REFUSED);
          expect(srv.store.voiceChecks.length).toBe(before);
        } else if (confidence === 'low') {
          expect(whoAsks).toHaveLength(1);
          expect(whoAsks[0].requestedSchema.properties.speaker.oneOf.map((o: { const: string }) => o.const)).toEqual(['sam', 'maya', 'someone_else']);
          expect(said(r)).not.toMatch(REFUSED);
          expect(srv.store.voiceChecks.length).toBe(before);
        } else {
          expect(whoAsks).toHaveLength(0);
          expect(r.isError).toBe(true);
          expect(said(r)).toMatch(REFUSED);
          expect(srv.store.voiceChecks.length).toBe(before + 1);
          expect(srv.store.voiceChecks.at(-1)).toMatchObject({ tool, confidence: 'unknown', device: 'sam' });
        }
        // Reads always do their job.
        if (kind === 'read') expect(r.isError).toBeFalsy();
        await d.client.close();
      });
    }
  }
});

describe("Who's speaking? Unknown voices", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    srv = await startServer();
  });
  afterEach(async () => {
    await srv.stop();
  });

  it('refuses to log a dose, records it in the care log and lists it in the next family summary once', async () => {
    const rose = await device(srv.url, 'rose');
    rose.hears('unknown');
    const r = await call(rose.client, 'log_medication', { spoken_name: 'metformin' });
    expect(said(r)).toBe(
      "Sorry, I don't recognise this voice, so I can't log Rose's 8 am Metformin. I've noted it in the care log for the family. You can still ask how Rose is doing."
    );
    expect(srv.store.doseLogs.filter(l => l.source === 'voice')).toHaveLength(0);

    // Questions still work for an unknown voice.
    const status = await call(rose.client, 'get_care_status');
    expect(status.isError).toBeFalsy();

    const today = await rose.client.readResource({ uri: 'carecircle://family/fam-rose/today' });
    const snapshot = JSON.parse((today.contents[0] as { text: string }).text);
    expect(snapshot.voiceChecks).toEqual([
      expect.objectContaining({ device: 'Rose', attempted: "log Rose's 8 am Metformin", text: "An unrecognised voice tried to log Rose's 8 am Metformin. That was at 9 am, and nothing was changed." })
    ]);

    const sam = await device(srv.url, 'sam');
    const first = await call(sam.client, 'send_daily_summary');
    expect(first.structuredContent?.text).toContain("Voice check: An unrecognised voice tried to log Rose's 8 am Metformin. That was at 9 am, and nothing was changed.");
    const second = await call(sam.client, 'send_daily_summary');
    expect(second.structuredContent?.text).not.toContain('Voice check');
    await rose.client.close();
    await sam.client.close();
  });

  it('describes each kind of change in plain words', async () => {
    const caller = await callerFor('sam', srv.deps);
    const say = (tool: string, args: Record<string, unknown> = {}) => describeAttempt(srv.deps, caller, tool, args);
    expect(await say('log_medication', { spoken_name: 'metformin' })).toBe("log Rose's 8 am Metformin");
    expect(await say('log_medication', {})).toBe("log Rose's 8 am Metformin and Vitamin D3");
    expect(await say('log_medication', { spoken_name: 'her morning pills' })).toBe("log Rose's 8 am Metformin and Vitamin D3");
    expect(await say('log_medication', { spoken_name: 'the purple ones' })).toBe('log a dose for Rose');
    expect(await say('log_medication', { slot: 'evening', status: 'skipped' })).toBe("mark Rose's 8 pm Metformin and Amlodipine as skipped");
    expect(await say('request_refill', { spoken_name: 'amlodipine' })).toBe("reorder Rose's Amlodipine");
    expect(await say('coordinate_appointment', { specialty: 'cardiology follow-up' })).toBe("book Rose's cardiology follow-up");
    expect(await say('send_daily_summary')).toBe('send the family summary');
  });
});

describe("Who's speaking? Unsure matches", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let origin: string;
  beforeEach(async () => {
    srv = await startServer();
    origin = new URL(srv.url).origin;
  });
  afterEach(async () => {
    await srv.stop();
  });

  const form = { elicitation: { form: {} } };
  const urlOnly = { elicitation: { url: {} } };

  it('asks who is speaking, offering only the household members it was unsure between, then acts as them', async () => {
    const sam = await device(srv.url, 'sam', { caps: form, answer: async () => ({ action: 'accept', content: { speaker: 'maya' } }) });
    sam.hears('low', 'maya,sam,stranger');
    const r = await call(sam.client, 'log_medication', { spoken_name: 'metformin' });
    expect(sam.asked).toHaveLength(1);
    expect(sam.asked[0].message).toBe("I'm not sure who's speaking. Before I log Rose's 8 am Metformin, who is this?");
    expect(sam.asked[0].requestedSchema.properties.speaker.oneOf).toEqual([
      { const: 'maya', title: 'Maya' },
      { const: 'sam', title: 'Sam' },
      { const: 'someone_else', title: 'Someone else' }
    ]);
    expect(r.structuredContent?.result).toBe('logged');
    // Maya logged Rose's dose from Sam's device: the log says Maya.
    expect(r.structuredContent?.logged[0]).toMatchObject({ name: 'Metformin', loggedBy: 'maya' });
    expect(srv.store.doseLogs.find(l => l.source === 'voice')?.loggedBy).toBe('maya');
    await sam.client.close();
  });

  it('a confirmed person still needs the role for the change', async () => {
    const sam = await device(srv.url, 'sam', { caps: form, answer: async a => (isWhoAsk(a) ? { action: 'accept', content: { speaker: 'maya' } } : { action: 'decline' }) });
    sam.hears('low', 'sam,maya');
    const r = await call(sam.client, 'request_refill');
    expect(r.isError).toBe(true);
    expect(said(r)).toMatch(/Sorry, Maya, your role/);
    await sam.client.close();
  });

  it('"Someone else" refuses and records it; declining changes nothing and records nothing', async () => {
    let pick: 'someone_else' | 'decline' = 'someone_else';
    const sam = await device(srv.url, 'sam', {
      caps: form,
      answer: async () => (pick === 'decline' ? { action: 'decline' } : { action: 'accept', content: { speaker: 'someone_else' } })
    });
    sam.hears('low', 'sam,maya');
    const r = await call(sam.client, 'log_wellbeing', { note: 'Rose feels fine' });
    expect(said(r)).toMatch(REFUSED);
    expect(srv.store.voiceChecks).toEqual([expect.objectContaining({ confidence: 'low', tool: 'log_wellbeing' })]);

    pick = 'decline';
    const d = await call(sam.client, 'log_wellbeing', { note: 'Rose feels fine' });
    expect(said(d)).toBe("Okay, I haven't changed anything.");
    expect(srv.store.voiceChecks).toHaveLength(1);
    expect(srv.store.wellbeing.filter(n => n.note === 'Rose feels fine')).toHaveLength(0);
    await sam.client.close();
  });

  it('without forms, asks for a phone confirmation through URL elicitation and then acts as the person who confirmed', async () => {
    const sam = await device(srv.url, 'sam', { caps: urlOnly, answer: async () => ({ action: 'accept' }) });
    sam.hears('low', 'sam,maya');
    const pending = call(sam.client, 'log_medication', { spoken_name: 'metformin' });
    await expect.poll(() => sam.asked.length).toBe(1);
    const ask = sam.asked[0];
    expect(ask.mode).toBe('url');
    expect(ask.message).toBe("I'm not sure who's speaking. To log Rose's 8 am Metformin, confirm it was you on your phone.");
    expect(ask.url).toMatch(new RegExp(`^${origin}/voice-check/[A-Za-z0-9_-]{43}$`));

    const page = await (await fetch(ask.url!)).text();
    expect(page).toContain('Was this you?');
    expect(page).toContain('Yes, it was me (Sam)');
    expect(page).toContain('Yes, it was me (Maya)');
    expect(srv.store.doseLogs.filter(l => l.source === 'voice')).toHaveLength(0);

    const crossSite = await fetch(ask.url!, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' }, body: 'member=sam' });
    expect(crossSite.status).toBe(403);
    const confirm = await fetch(ask.url!, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin }, body: 'member=sam' });
    expect(await confirm.text()).toContain('Thanks, Sam');

    const r: ToolResult = await pending;
    expect(r.structuredContent?.logged[0]).toMatchObject({ name: 'Metformin', loggedBy: 'sam' });
    await expect.poll(() => sam.completed).toEqual([ask.elicitationId]);
    // One use only.
    expect((await fetch(ask.url!)).status).toBe(404);
    await sam.client.close();
  });

  it('a phone answer of "No, it wasn\'t me" refuses and records it', async () => {
    const sam = await device(srv.url, 'sam', { caps: urlOnly, answer: async () => ({ action: 'accept' }) });
    sam.hears('low', 'sam,maya');
    const pending = call(sam.client, 'set_language', { language: 'hi' });
    await expect.poll(() => sam.asked.length).toBe(1);
    await fetch(sam.asked[0].url!, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin }, body: 'member=someone_else' });
    expect(said(await pending)).toMatch(REFUSED);
    expect((await srv.store.getMember('sam'))?.language ?? 'en').toBe('en');
    expect(srv.store.voiceChecks).toEqual([expect.objectContaining({ confidence: 'low', tool: 'set_language' })]);
    await sam.client.close();
  });

  it('an unanswered phone confirmation times out and changes nothing', async () => {
    srv.deps.voiceCheckTimeoutMs = 150;
    const sam = await device(srv.url, 'sam', { caps: urlOnly, answer: async () => ({ action: 'accept' }) });
    sam.hears('low', 'sam');
    const r = await call(sam.client, 'log_medication', { spoken_name: 'metformin' });
    expect(said(r)).toBe("I didn't get a confirmation, so I haven't changed anything.");
    expect(srv.store.doseLogs.filter(l => l.source === 'voice')).toHaveLength(0);
    await sam.client.close();
  });

  it('a client with no elicitation at all changes nothing', async () => {
    const sam = await device(srv.url, 'sam');
    sam.hears('low', 'sam,maya');
    const r = await call(sam.client, 'log_medication', { spoken_name: 'metformin' });
    expect(said(r)).toBe("I'm not sure who's speaking, so I can't log Rose's 8 am Metformin from here. Please ask again from your own device.");
    expect(srv.store.doseLogs.filter(l => l.source === 'voice')).toHaveLength(0);
    await sam.client.close();
  });
});

describe('Logging for someone else', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.stop();
  });

  it("records who logged Rose's dose, in the log and in her status", async () => {
    const sam = await device(srv.url, 'sam');
    const r = await call(sam.client, 'log_medication', { spoken_name: 'metformin' });
    expect(said(r)).toMatch(/^Got it\. Logged Metformin for the morning for Rose\./);
    expect(r.structuredContent?.logged[0].loggedBy).toBe('sam');
    const status = await call(sam.client, 'get_care_status', { detail: 'full' });
    const dose = status.structuredContent?.doses.find((d: { name: string; slot: string }) => d.name === 'Metformin' && d.slot === 'morning');
    expect(dose).toMatchObject({ status: 'taken', loggedBy: 'sam' });
    await sam.client.close();
  });
});
