import { EventEmitter } from 'node:events';
import type { CareStore } from './types.js';

/** What changed. Sessions turn these into `notifications/resources/updated`. */
export type ChangeKind = 'dose' | 'supply' | 'wellbeing' | 'order' | 'member' | 'message' | 'visit' | 'task' | 'preference' | 'voice' | 'checkin' | 'clock';

export interface Change {
  familyId: string;
  kind: ChangeKind;
}

/** Family-wide change feed shared by every session of the server. */
export class ChangeHub {
  private emitter = new EventEmitter();

  constructor() {
    // One listener per open session; the default cap of 10 is too low for a family.
    this.emitter.setMaxListeners(0);
  }

  emit(change: Change): void {
    this.emitter.emit('change', change);
  }

  /** Returns an unsubscribe function. */
  on(listener: (change: Change) => void): () => void {
    this.emitter.on('change', listener);
    return () => this.emitter.off('change', listener);
  }
}

type Writes = {
  [K in keyof CareStore]?: { kind: ChangeKind; family: (args: any[], result: any) => string | undefined };
};

/** Every store write that someone else's screen should react to, and where its family id lives. */
const WRITES: Writes = {
  addDoseLog: { kind: 'dose', family: ([log]) => log.familyId },
  adjustPills: { kind: 'supply', family: ([familyId]) => familyId },
  addWellbeing: { kind: 'wellbeing', family: ([note]) => note.familyId },
  addOrder: { kind: 'order', family: ([order]) => order.familyId },
  transitionOrder: { kind: 'order', family: (_args, order) => order?.familyId },
  setMemberLanguage: { kind: 'member', family: (_args, member) => member?.familyId },
  addMessage: { kind: 'message', family: ([message]) => message.familyId },
  addVisit: { kind: 'visit', family: ([visit]) => visit.familyId },
  addHelperTask: { kind: 'task', family: ([task]) => task.familyId },
  setPreference: { kind: 'preference', family: ([preference]) => preference.familyId },
  removePreference: { kind: 'preference', family: ([familyId]) => familyId },
  addVoiceCheck: { kind: 'voice', family: ([check]) => check.familyId },
  setCheckInSettings: { kind: 'checkin', family: ([settings]) => settings.familyId },
  saveCheckIn: { kind: 'checkin', family: ([checkIn]) => checkIn.familyId }
};

/**
 * Wraps a store so each successful write is announced on the hub. Works for any
 * CareStore (memory now, DynamoDB later), including writes from the checkout page.
 */
export function watchStore(store: CareStore, hub: ChangeHub): CareStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      const write = WRITES[prop as keyof CareStore];
      if (!write || typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const result = await value.apply(target, args);
        const familyId = write.family(args, result);
        if (familyId) hub.emit({ familyId, kind: write.kind });
        return result;
      };
    }
  });
}
