import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { call, connect, said, startServer } from './helpers.js';

let srv: Awaited<ReturnType<typeof startServer>>;
const open: Client[] = [];
beforeEach(async () => {
  srv = await startServer();
});
afterEach(async () => {
  await Promise.all(open.splice(0).map(c => c.close().catch(() => undefined)));
  await srv.stop();
});

const TODAY = 'carecircle://family/fam-rose/today';
const INBOX = 'carecircle://family/fam-rose/inbox';

async function as(user: string) {
  const c = await connect(srv.url, user);
  open.push(c);
  return c;
}

/** Collects resources/updated notifications for one client. */
function updates(c: Client) {
  const uris: string[] = [];
  c.setNotificationHandler('notifications/resources/updated', n => {
    uris.push(n.params.uri);
  });
  return {
    uris,
    async next(uri: string, timeoutMs = 3000) {
      const start = Date.now();
      while (!uris.includes(uri)) {
        if (Date.now() - start > timeoutMs) throw new Error(`no update for ${uri}; got ${JSON.stringify(uris)}`);
        await new Promise(r => setTimeout(r, 20));
      }
    }
  };
}

async function readJson(c: Client, uri: string) {
  const { contents } = await c.readResource({ uri });
  return JSON.parse((contents[0] as { text: string }).text);
}

describe('live family updates', () => {
  it("pushes Rose's dose to Sam's screen, once per burst", async () => {
    const rose = await as('rose');
    const sam = await as('sam');
    const seen = updates(sam);
    await sam.subscribeResource({ uri: TODAY });

    await call(rose, 'log_medication', { medication_ids: ['med-metformin'], slot: 'morning' });
    await seen.next(TODAY);
    await new Promise(r => setTimeout(r, 300));
    // The dose log and the pill count change arrive as one notification.
    expect(seen.uris.filter(u => u === TODAY)).toHaveLength(1);

    const today = await readJson(sam, TODAY);
    expect(today.viewer).toMatchObject({ id: 'sam', role: 'coordinator', language: 'en' });
    expect(today.status.doses.find((d: any) => d.medicationId === 'med-metformin' && d.slot === 'morning').status).toBe('taken');
  });

  it('turns a red flag into an alert for the family', async () => {
    const rose = await as('rose');
    const maya = await as('maya');
    const seen = updates(maya);
    await maya.subscribeResource({ uri: TODAY });

    await call(rose, 'log_wellbeing', { note: 'I had a fall in the kitchen' });
    await seen.next(TODAY);
    const { alerts } = await readJson(maya, TODAY);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ loggedBy: 'rose', reasons: ['a fall'] });
    expect(alerts[0].text).toBe('CareCircle alert: at 9 am, Rose said: I had a fall in the kitchen. That mentions a fall. Please check on her.');
  });

  it("refuses subscriptions to another family or to resources that don't change", async () => {
    const sam = await as('sam');
    await expect(sam.subscribeResource({ uri: 'carecircle://family/fam-other/today' })).rejects.toThrow();
    await expect(sam.subscribeResource({ uri: 'carecircle://family/fam-rose/care-plan' })).rejects.toThrow();
  });

  it('stops notifying after unsubscribe', async () => {
    const rose = await as('rose');
    const sam = await as('sam');
    const seen = updates(sam);
    await sam.subscribeResource({ uri: TODAY });
    await sam.unsubscribeResource({ uri: TODAY });
    await call(rose, 'log_medication', { medication_ids: ['med-vitd'] });
    await new Promise(r => setTimeout(r, 400));
    expect(seen.uris).toEqual([]);
  });
});

describe('gentle reminders', () => {
  it("reminds Rose about this morning's doses, and only Rose", async () => {
    const rose = await as('rose');
    const { reminder } = await readJson(rose, TODAY);
    expect(reminder).toMatchObject({ key: '2026-10-10:morning', slot: 'morning', time: '08:00', medicationIds: ['med-metformin', 'med-vitd'] });
    expect(reminder.text).toBe("Rose, a gentle reminder: your Metformin and Vitamin D3 from 8 am aren't logged yet. Have you taken them?");
    expect((await readJson(await as('sam'), TODAY)).reminder).toBeNull();

    await call(rose, 'log_medication', {});
    expect((await readJson(rose, TODAY)).reminder).toBeNull();
  });
});

describe('Hindi', () => {
  it("speaks Hindi to Rose once she asks, and English to everyone else", async () => {
    const rose = await as('rose');
    const sam = await as('sam');
    const set = await call(rose, 'set_language', { language: 'hi' });
    expect(said(set)).toBe('ठीक है Rose जी, अब मैं आपसे हिंदी में बात करूँगी।');

    expect(said(await call(rose, 'get_care_status'))).toBe(
      'सुप्रभात, Rose जी। आज आपने अभी तक कोई खुराक नहीं ली है, कुल 5 हैं। Metformin और Vitamin D3 अभी लेनी है। Maya शाम 4 बजे आएंगी। आपने बताया था: Slept badly last night। Amlodipine कम है: लगभग 3 दिन की बची है।'
    );
    expect(said(await call(rose, 'log_medication', {}))).toBe('ठीक है। मैंने सुबह की Metformin और Vitamin D3 दर्ज कर ली है। अगली दवा Amlodipine है, रात 8 बजे।');
    expect(said(await call(rose, 'list_medications', { when: 'night' }))).toBe('आज रात 10 बजे आपको लेनी है: Atorvastatin 10 mg।');
    expect((await readJson(rose, TODAY)).viewer.language).toBe('hi');

    expect(said(await call(sam, 'get_care_status'))).toMatch(/^Rose has taken two of her five doses so far today\./);
  });

  it('recognises a fall said in Hindi as a red flag', async () => {
    const rose = await as('rose');
    await call(rose, 'set_language', { language: 'hi' });
    const r = await call(rose, 'log_wellbeing', { note: 'मैं रसोई में गिर गई' });
    expect(r.structuredContent).toMatchObject({ redFlag: true, reasons: ['a fall'], severity: 'high' });
    expect(said(r)).toBe(
      'मैंने यह दर्ज कर लिया है। गिरना गंभीर हो सकता है। अगर तकलीफ़ ज़्यादा है या अचानक हुई है, तो अभी इमरजेंसी सेवा को फ़ोन करें। Sam और Maya को यह नोट तुरंत दिखेगा।'
    );
  });
});

describe('evening summary', () => {
  it('sends Sam and Maya a written summary and updates their inbox', async () => {
    const rose = await as('rose');
    const sam = await as('sam');
    const maya = await as('maya');
    const seen = updates(maya);
    await maya.subscribeResource({ uri: INBOX });

    await call(rose, 'log_medication', {});
    await call(rose, 'log_wellbeing', { note: 'I had a fall in the kitchen' });
    const r = await call(sam, 'send_daily_summary');
    expect(said(r)).toBe("Done. I've sent today's summary to Sam and Maya in the CareCircle app.");
    expect(r.structuredContent?.to.map((t: any) => t.id)).toEqual(['sam', 'maya']);
    expect(r.structuredContent?.text).toBe(
      [
        "Rose's day: Saturday 10 October",
        '',
        'Medicines: 2 of 5 doses taken so far; 3 still to come.',
        'Alert, 9 am: "I had a fall in the kitchen" (a fall).',
        'Notes: 7:45 am, Slept badly last night.',
        'Supply: Amlodipine has about three days left. No refill ordered yet.',
        'Visits: Maya at 4 pm.',
        'Past 7 days: one dose missed.',
        '',
        'CareCircle coordinates care. It does not give medical advice.'
      ].join('\n')
    );

    await seen.next(INBOX);
    const { messages } = await readJson(maya, INBOX);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: 'daily_summary', sentBy: 'sam', delivery: { inbox: true, sns: 'off' } });
    // Rose isn't sent her own summary.
    expect((await readJson(rose, INBOX)).messages).toEqual([]);
  });
});
