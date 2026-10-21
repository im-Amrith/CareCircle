import { useEffect, useState } from 'react';
import { CalendarHeart, Pill } from 'lucide-react';
import type { Language, ProfileId, Today } from './api';
import { clock } from './cards/Cards';
import { FAMILY_TZ, nameOf } from './model';

/* ---------- the family's clock ---------- */

/** A server clock this far from ours is frozen for the demo (CARECIRCLE_NOW), so it doesn't tick. */
const FROZEN_AFTER_MS = 6 * 60 * 60 * 1000;

/** The last server time any device heard, for a device whose own live state hasn't arrived yet. */
let lastServerTime = NaN;

/** The time on the device: the server's frozen demo clock if it has one, otherwise now. */
export function useFamilyClock(live: Today | null): Date {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const server = live ? Date.parse(live.updatedAt) : lastServerTime;
  if (live) lastServerTime = server;
  return new Date(Number.isFinite(server) && Math.abs(server - now) > FROZEN_AFTER_MS ? server : now);
}

export const timeOf = (d: Date, lang: Language = 'en') =>
  d.toLocaleTimeString(lang === 'hi' ? 'hi-IN' : 'en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: FAMILY_TZ });

const dateOf = (d: Date, lang: Language) =>
  d.toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: FAMILY_TZ });

/* ---------- avatars ---------- */

export function Avatar({ profile, size = 'md' }: { profile: ProfileId; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`avatar avatar-${profile} avatar-${size}`} aria-hidden="true">
      {nameOf(profile)[0]}
    </span>
  );
}

/* ---------- today's doses as a ring ---------- */

/** Today's doses as a ring; `bare` leaves the numbers to the text beside it. */
export function DoseRing({ taken, total, label, bare }: { taken: number; total: number; label?: string; bare?: boolean }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const share = total ? taken / total : 0;
  return (
    <figure className="dose-ring" aria-label={`${taken} of ${total} doses taken today`}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="dose-ring-track" cx="50" cy="50" r={r} />
        {share > 0 && <circle className="dose-ring-fill" cx="50" cy="50" r={r} strokeDasharray={`${share * c} ${c}`} transform="rotate(-90 50 50)" />}
      </svg>
      {!bare && <figcaption>
        <span className="dose-ring-num">
          {taken}
          <span className="dose-ring-of"> of {total}</span>
        </span>
        <span className="dose-ring-label">{label ?? 'doses today'}</span>
      </figcaption>}
    </figure>
  );
}

/* ---------- the ambient home screen, like StandBy ---------- */

/** "9:00" and "am" apart, so the digits can be huge and the suffix quiet. */
function clockParts(d: Date, lang: Language) {
  const parts = new Intl.DateTimeFormat(lang === 'hi' ? 'hi-IN' : 'en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: FAMILY_TZ }).formatToParts(d);
  const digits = parts.filter(p => p.type === 'hour' || p.type === 'minute' || p.type === 'literal').map(p => p.value).join('').trim();
  const suffix = parts.find(p => p.type === 'dayPeriod')?.value ?? '';
  return { digits, suffix };
}

interface Props {
  profile: ProfileId;
  live: Today | null;
  lang: Language;
}

export function HomeScreen({ live, lang }: Props) {
  const now = useFamilyClock(live);
  const s = live?.status;
  const { digits, suffix } = clockParts(now, lang);
  const due: any[] = (s?.doses ?? []).filter((d: any) => d.status === 'due');
  const next = due.length ? { label: 'Due now', name: due.map(d => d.name).join(', '), time: clock(due[0].time) } : s?.nextDose ? { label: 'Next dose', name: s.nextDose.name, time: clock(s.nextDose.time) } : null;
  const visit = (s?.visits ?? [])[0];

  return (
    <div className="home">
      <div className="home-time">
        <p className="home-clock">
          {digits}
          <span className="home-clock-suffix">{suffix}</span>
        </p>
        <p className="home-date">{dateOf(now, lang)}</p>
      </div>
      {s && (
        <ul className="widgets" aria-label="Today">
          <li className={`widget${due.length ? ' widget-due' : ''}`}>
            <p className="widget-label">
              <Pill aria-hidden="true" /> {next?.label ?? 'Next dose'}
            </p>
            <p className="widget-value">{next?.name ?? 'All done'}</p>
            <p className="widget-meta">{next?.time ?? 'for today'}</p>
          </li>
          <li className="widget">
            <p className="widget-label">
              <CalendarHeart aria-hidden="true" /> Visit
            </p>
            <p className="widget-value">{visit ? visit.who : 'None today'}</p>
            <p className="widget-meta">{visit ? clock(visit.time) : ' '}</p>
          </li>
          <li className="widget widget-ring">
            <DoseRing taken={s.counts?.taken ?? 0} total={s.counts?.total ?? 0} bare />
            <div>
              <p className="widget-label">Today</p>
              <p className="widget-value">
                {s.counts?.taken ?? 0} of {s.counts?.total ?? 0}
              </p>
              <p className="widget-meta">doses taken</p>
            </div>
          </li>
        </ul>
      )}
    </div>
  );
}
