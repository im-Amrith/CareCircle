import { randomUUID } from 'node:crypto';
import type { EventStore, JSONRPCMessage } from '@modelcontextprotocol/server';

/**
 * Bounded in-memory event store so a dropped SSE stream can resume with
 * Last-Event-ID (Streamable HTTP resumability). One instance per session.
 * Event ids encode their stream id, as the spec recommends.
 */
export class MemoryEventStore implements EventStore {
  private events: { id: string; streamId: string; message: JSONRPCMessage }[] = [];

  constructor(private readonly max = 500) {}

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const id = `${streamId}::${randomUUID()}`;
    this.events.push({ id, streamId, message });
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
    return id;
  }

  async getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    return this.events.find(e => e.id === eventId)?.streamId;
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> }
  ): Promise<string> {
    const index = this.events.findIndex(e => e.id === lastEventId);
    if (index === -1) return '';
    const streamId = this.events[index].streamId;
    for (const e of this.events.slice(index + 1)) {
      if (e.streamId === streamId) await send(e.id, e.message);
    }
    return streamId;
  }
}
