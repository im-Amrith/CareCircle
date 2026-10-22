import { ResourceNotFoundError, ResourceTemplate, type McpServer, type ServerContext } from '@modelcontextprotocol/server';
import type { ChangeKind } from '../store/changes.js';
import { resolveCaller, type Deps } from './context.js';
import { todaySnapshot } from './status.js';

/**
 * Live family resources. Each session can `resources/subscribe` to them and gets
 * `notifications/resources/updated` whenever anyone in the family changes something:
 * Rose taps Mark taken on her display, and Sam's phone updates.
 *
 *   carecircle://family/{familyId}/today   status, safety alerts and reminders, in the reader's language
 *   carecircle://family/{familyId}/inbox   messages CareCircle sent the family (the evening summary)
 */
const TODAY = /^carecircle:\/\/family\/([^/]+)\/today$/;
const INBOX = /^carecircle:\/\/family\/([^/]+)\/inbox$/;

/** Which changes each resource reflects. */
const AFFECTS: Record<'today' | 'inbox', ChangeKind[]> = {
  today: ['dose', 'supply', 'wellbeing', 'order', 'member', 'visit', 'task', 'voice', 'checkin', 'clock'],
  inbox: ['message', 'clock']
};

/** Coalesce bursts (a dose log also adjusts the pill count) into one notification. */
const DEBOUNCE_MS = 120;

export function registerLiveResources(server: McpServer, deps: Deps): void {
  const json = (uri: URL, body: unknown) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body) }] });

  server.registerResource(
    'today',
    new ResourceTemplate('carecircle://family/{familyId}/today', {
      list: async ctx => {
        const caller = await resolveCaller(ctx, deps);
        return { resources: [{ uri: `carecircle://family/${caller.family.id}/today`, name: `${caller.recipient.name} today`, mimeType: 'application/json' }] };
      }
    }),
    {
      title: 'Today, live',
      description:
        "Today's care status for the reader, with safety alerts and (for the person being cared for) a gentle reminder about overdue doses. Subscribe to get notifications/resources/updated when anyone in the family logs something.",
      mimeType: 'application/json'
    },
    async (uri, variables, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      if (variables.familyId !== caller.family.id) throw new ResourceNotFoundError(uri.href);
      return json(uri, await todaySnapshot(deps, caller));
    }
  );

  server.registerResource(
    'inbox',
    new ResourceTemplate('carecircle://family/{familyId}/inbox', {
      list: async ctx => {
        const caller = await resolveCaller(ctx, deps);
        return { resources: [{ uri: `carecircle://family/${caller.family.id}/inbox`, name: 'Family messages', mimeType: 'application/json' }] };
      }
    }),
    {
      title: 'Family messages',
      description: 'Messages CareCircle sent the family, newest first: the evening summary. Subscribe to hear about new ones.',
      mimeType: 'application/json'
    },
    async (uri, variables, ctx) => {
      const caller = await resolveCaller(ctx, deps);
      if (variables.familyId !== caller.family.id) throw new ResourceNotFoundError(uri.href);
      const messages = (await deps.store.listMessages(caller.family.id, 10)).filter(m => m.to.includes(caller.member.id) || caller.member.role === 'coordinator');
      return json(uri, { messages });
    }
  );

  // ---- subscriptions (one set per session) ----
  const subscribed = new Map<string, { familyId: string; kind: 'today' | 'inbox' }>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const parse = (uri: string) => {
    const today = TODAY.exec(uri);
    if (today) return { familyId: today[1], kind: 'today' as const };
    const inbox = INBOX.exec(uri);
    if (inbox) return { familyId: inbox[1], kind: 'inbox' as const };
    return undefined;
  };

  server.server.setRequestHandler('resources/subscribe', async (request, ctx) => {
    const uri = request.params.uri;
    const target = parse(uri);
    const caller = await resolveCaller(ctx as ServerContext, deps);
    // Only your own family, and only resources that change.
    if (!target || target.familyId !== caller.family.id) throw new ResourceNotFoundError(uri);
    subscribed.set(uri, target);
    return {};
  });

  server.server.setRequestHandler('resources/unsubscribe', async request => {
    subscribed.delete(request.params.uri);
    return {};
  });

  const stop = deps.changes?.on(change => {
    for (const [uri, target] of subscribed) {
      if (target.familyId !== change.familyId || !AFFECTS[target.kind].includes(change.kind) || pending.has(uri)) continue;
      pending.set(
        uri,
        setTimeout(() => {
          pending.delete(uri);
          if (!subscribed.has(uri)) return;
          server.server.sendResourceUpdated({ uri }).catch(() => undefined);
        }, DEBOUNCE_MS)
      );
    }
  });

  const previous = server.server.onclose;
  server.server.onclose = () => {
    previous?.();
    stop?.();
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
    subscribed.clear();
  };
}
