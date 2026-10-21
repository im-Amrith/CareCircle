import { useEffect, useState } from 'react';
import { CalendarHeart, Pill } from 'lucide-react';
import type { Language, ProfileId, Today } from './api';
import { clock } from './cards/Cards';
import { FAMILY_TZ, nameOf } from './model';

/* ---------- the family's clock ---------- */

/** A server clock this far from ours is frozen for the demo (CARECIRCLE_NOW), so it doesn't tick. */
const FROZEN_AFTER_MS = 6 * 60 * 60 * 1000;

/** The time on the device: the server's frozen demo clock if it has one, otherwise now. */
export function useFamilyClock(live: Today | null): Date {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const server = live ? Date.parse(live.updatedAt) : NaN;
  return new Date(Number.isFinite(server) && Math.abs(server - now) > FROZEN_AFTER_MS ? server : now);
}

export const timeOf = (d: Date, lang: Language = 'en') =>
  d.toLocaleTimeString(lang === 'hi' ? 'hi-IN' : 'en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: FAMILY_TZ });

const dateOf = (d: Date, lang: Language) =>
  d.toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: FAMILY_TZ });

const hourOf = (d: Date) => Number(d.toLocaleTimeString('en-GB', { hour: '2-digit', hour12: false, timeZone: FAMILY_TZ }));

/* ---------- avatars ---------- */

export function Avatar({ profile, size = 'md' }: { profile: ProfileId; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`avatar avatar-${profile} avatar-${size}`} aria-hidden="true">
      {nameOf(profile)[0]}
    </span>
  );
}

/* ---------- today's doses as a ring ---------- */

export function DoseRing({ taken, total, label }: { taken: number; total: number; label?: string }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const share = total ? taken / total : 0;
  return (
    <figure className="dose-ring" aria-label={`${taken} of ${total} doses taken today`}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="dose-ring-track" cx="50" cy="50" r={r} />
        {share > 0 && <circle className="dose-ring-fill" cx="50" cy="50" r={r} strokeDasharray={`${share * c} ${c}`} transform="rotate(-90 50 50)" />}
      </svg>
      <figcaption>
        <span className="dose-ring-num">
          {taken}
          <span className="dose-ring-of"> of {total}</span>
        </span>
        <span className="dose-ring-label">{label ?? 'doses today'}</span>
      </figcaption>
    </figure>
  );
}

/* ---------- the ambient home screen ---------- */

interface Props {
  profile: ProfileId;
  live: Today | null;
  lang: Language;
  suggestion: string;
}

export function HomeScreen({ profile, live, lang, suggestion }: Props) {
  const now = useFamilyClock(live);
  const s = live?.status;
  const hi = lang === 'hi';
  const hour = hourOf(now);
  const greeting = hi ? 'नमस्ते' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const recipient: string = s?.recipient?.name ?? 'Rose';
  const isRecipient = live?.viewer.role === 'recipient';
  const due: any[] = (s?.doses ?? []).filter((d: any) => d.status === 'due');
  const visit = (s?.visits ?? [])[0];

  return (
    <div className="home">
      <div className="home-main">
        <p className="home-greeting">
          {greeting}, {nameOf(profile)}
        </p>
        <p className="home-clock">{timeOf(now, lang)}</p>
        <p className="home-date">{dateOf(now, lang)}</p>
        <p className="home-hint">
          {hi ? 'बोलकर देखें' : 'Try saying'} “{suggestion}”
        </p>
      </div>
      {s && (
        <div className="home-side">
          <DoseRing taken={s.counts?.taken ?? 0} total={s.counts?.total ?? 0} label={isRecipient ? 'doses today' : `${recipient}'s doses`} />
          <ul className="home-tiles">
            {due.length > 0 ? (
              <li className="home-tile home-tile-due">
                <Pill aria-hidden="true" />
                <span>
                  <strong>Due now</strong> {due.map(d => d.name).join(', ')}
                </span>
              </li>
            ) : (
              s.nextDose && (
                <li className="home-tile">
                  <Pill aria-hidden="true" />
                  <span>
                    <strong>Next</strong> {s.nextDose.name} at {clock(s.nextDose.time)}
                  </span>
                </li>
              )
            )}
            {visit && (
              <li className="home-tile">
                <CalendarHeart aria-hidden="true" />
                <span>
                  <strong>{visit.who}</strong> visits at {clock(visit.time)}
                </span>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
