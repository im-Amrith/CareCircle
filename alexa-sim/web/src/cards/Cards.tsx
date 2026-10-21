import type { ReactNode } from 'react';
import {
  CalendarHeart,
  Check,
  CircleAlert,
  CircleDashed,
  Clock,
  HeartHandshake,
  type LucideIcon,
  Minus,
  NotebookPen,
  Package,
  Phone,
  Pill,
  ShieldAlert,
  ShoppingBag,
  Sun,
  Sunrise,
  Sunset,
  Moon,
  Users,
  X
} from 'lucide-react';
import type { ToolResult } from '../api';

/* ---------- small helpers ---------- */

export function clock(time?: string) {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  if (h === 12 && m === 0) return 'Noon';
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

function day(date?: string) {
  if (!date) return '';
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const sentenceCase = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

type DoseStatus = 'taken' | 'skipped' | 'due' | 'upcoming' | 'missed';

const STATUS_LABEL: Record<DoseStatus, string> = {
  taken: 'Taken',
  skipped: 'Skipped',
  due: 'Due now',
  upcoming: 'Later',
  missed: 'Missed'
};

const STATUS_ICON: Record<DoseStatus, LucideIcon> = {
  taken: Check,
  skipped: Minus,
  due: Clock,
  upcoming: CircleDashed,
  missed: X
};

function StatusMark({ status }: { status: DoseStatus }) {
  const Icon = STATUS_ICON[status] ?? CircleDashed;
  return (
    <span className={`mark mark-${status}`} title={STATUS_LABEL[status]}>
      <Icon aria-hidden="true" />
      <span className="sr-only">{STATUS_LABEL[status]}</span>
    </span>
  );
}

type Order = {
  name: string;
  strength: string;
  quantity: number;
  pharmacy: string;
  fulfilment: 'delivery' | 'pickup';
  status: 'awaiting_checkout' | 'placed' | 'cancelled' | 'expired';
  readyOn?: string;
};

function orderLine(o: Order) {
  switch (o.status) {
    case 'awaiting_checkout':
      return 'Waiting for checkout';
    case 'placed':
      return o.fulfilment === 'delivery' ? `Arrives ${day(o.readyOn)}` : `Pick up ${day(o.readyOn)}`;
    case 'cancelled':
      return 'Cancelled';
    case 'expired':
      return 'Checkout link expired';
  }
}

type Tone = 'warn' | 'alert' | 'ok';

function Card({ title, icon: Icon, tone, children, meta }: { title: string; icon: LucideIcon; tone?: Tone; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className={`card${tone ? ` card-${tone}` : ''}`} aria-label={title}>
      <header className="card-head">
        <span className="card-icon" aria-hidden="true">
          <Icon />
        </span>
        <h3 className="card-title">{title}</h3>
        {meta && <span className="card-meta">{meta}</span>}
      </header>
      {children}
    </section>
  );
}

function Fact({ icon: Icon, children, tone }: { icon: LucideIcon; children: ReactNode; tone?: Tone }) {
  return (
    <li className={`fact${tone ? ` fact-${tone}` : ''}`}>
      <Icon aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
}

function Options({ options }: { options: any[] }) {
  return (
    <ul className="options">
      {options.map((x: any) => (
        <li key={x.id} className="option">
          <Pill aria-hidden="true" />
          <span>
            <strong>{x.name}</strong> <span className="muted">{x.purpose}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ---------- today's care: a dose timeline ---------- */

const SLOTS: { id: string; label: string; icon: LucideIcon }[] = [
  { id: 'morning', label: 'Morning', icon: Sunrise },
  { id: 'noon', label: 'Noon', icon: Sun },
  { id: 'evening', label: 'Evening', icon: Sunset },
  { id: 'night', label: 'Night', icon: Moon }
];

function CareStatus({ s }: { s: Record<string, any> }) {
  const doses: any[] = s.doses ?? [];
  const taken = s.counts?.taken ?? 0;
  const total = s.counts?.total ?? 0;
  return (
    <Card title={`${s.recipient?.name ?? 'Today'}’s day`} icon={HeartHandshake} meta={day(s.date)}>
      <p className="headline">
        <span className="headline-num">{taken}</span> of {total} doses taken
      </p>
      <ol className="timeline" aria-label="Today's doses">
        {SLOTS.map(slot => {
          const here = doses.filter(d => d.slot === slot.id);
          if (!here.length) return null;
          const Icon = slot.icon;
          return (
            <li key={slot.id} className="slot">
              <p className="slot-head">
                <Icon aria-hidden="true" />
                <span>{slot.label}</span>
                <span className="slot-time">{clock(here[0].time)}</span>
              </p>
              <ul className="slot-doses">
                {here.map(d => (
                  <li key={d.medicationId} className={`dose dose-${d.status}`}>
                    <StatusMark status={d.status} />
                    <span className="dose-name">{d.name}</span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
      <ul className="facts">
        {s.nextDose && (
          <Fact icon={Pill}>
            Next: <strong>{s.nextDose.name}</strong> at {clock(s.nextDose.time)}
          </Fact>
        )}
        {(s.visits ?? []).map((v: any) => (
          <Fact key={`${v.who}-${v.time}`} icon={CalendarHeart}>
            <strong>{v.who}</strong> visits at {clock(v.time)}
          </Fact>
        ))}
        {s.latestWellbeing && (
          <Fact icon={s.latestWellbeing.redFlag ? ShieldAlert : NotebookPen} tone={s.latestWellbeing.redFlag ? 'alert' : undefined}>
            {s.latestWellbeing.note}
          </Fact>
        )}
        {(s.refillAlerts ?? []).map((a: any) => (
          <Fact key={a.medicationId} icon={a.order ? Package : CircleAlert} tone={a.order ? undefined : 'warn'}>
            <strong>{a.name}</strong>: {a.daysLeft} days left{a.order ? ` · ${orderLine(a.order)}` : ''}
          </Fact>
        ))}
      </ul>
    </Card>
  );
}

/* ---------- supplies ---------- */

/** Days of supply as a bar; a month fills it. */
function SupplyGauge({ days, low }: { days: number; low: boolean }) {
  const share = Math.max(0.04, Math.min(1, days / 30));
  return (
    <div className={`gauge${low ? ' gauge-low' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={30} aria-valuenow={days} aria-label={`${days} days left`}>
      <span className="gauge-fill" style={{ width: `${share * 100}%` }} />
    </div>
  );
}

function Medications({ s }: { s: Record<string, any> }) {
  const meds: any[] = s.medications ?? [];
  return (
    <Card title={s.when ? `${sentenceCase(s.when)} medicines` : 'Medicines'} icon={Pill}>
      <ul className="rows">
        {meds.map(m => (
          <li key={m.id} className="row">
            <div className="row-text">
              <p className="row-main">
                {m.name} <span className="muted">{m.strength}</span>
              </p>
              <p className="row-sub">
                {m.purpose} · {m.schedule.map((x: any) => `${clock(x.time)}${x.instructions ? ` ${x.instructions}` : ''}`).join(', ')}
              </p>
            </div>
            <span className={`days${m.daysLeft <= 7 ? ' days-low' : ''}`}>{m.daysLeft} days</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Refills({ s }: { s: Record<string, any> }) {
  const alerts: any[] = s.alerts ?? [];
  if (!alerts.length) {
    return (
      <Card title="Supplies" icon={Package} tone="ok">
        <p className="lead">Everything has more than {s.withinDays} days left.</p>
      </Card>
    );
  }
  return (
    <Card title="Running low" icon={Package} tone={alerts.some(a => !a.order) ? 'warn' : undefined}>
      <ul className="rows">
        {alerts.map(a => (
          <li key={a.medicationId} className="supply">
            <p className="row-main">
              {a.name} <span className="muted">{a.strength}</span>
            </p>
            <div className="supply-line">
              <SupplyGauge days={a.daysLeft} low={!a.order} />
              <span className={`days${a.order ? '' : ' days-low'}`}>{a.daysLeft} days left</span>
            </div>
            <p className="row-sub">
              {a.pillsOnHand} tablets · runs out {day(a.runsOutOn)} · {a.pharmacy?.name}
            </p>
            {a.order && <OrderSteps o={a.order} />}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ---------- a refill order: requested → checkout → placed → arriving ---------- */

const STEPS = ['Requested', 'Checkout', 'Placed', 'Arriving'];

function OrderSteps({ o, checkout }: { o: Order; checkout?: CheckoutState }) {
  if (o.status === 'cancelled' || o.status === 'expired') return <p className="status-line status-off">{orderLine(o)}</p>;
  const placed = o.status === 'placed' || checkout === 'complete';
  // The step being worked on now; everything before it is done.
  const current = placed ? 3 : 1;
  // The date is known once the order is placed; a card from before checkout doesn't have it.
  const pickup = o.fulfilment === 'pickup';
  const last = placed && o.readyOn ? (pickup ? `Pick up ${day(o.readyOn)}` : `Arrives ${day(o.readyOn)}`) : pickup ? 'Ready to pick up' : STEPS[3];
  return (
    <ol className="steps" aria-label="Order progress">
      {STEPS.map((label, i) => {
        const state = i < current ? 'done' : i === current ? 'now' : 'todo';
        return (
          <li key={label} className={`step step-${state}`} aria-current={state === 'now' ? 'step' : undefined}>
            <span className="step-dot" aria-hidden="true">
              {state === 'done' && <Check />}
            </span>
            <span className="step-label">{i === 3 ? last : label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function RefillOrder({ s, checkout }: { s: Record<string, any>; checkout?: CheckoutState }) {
  const o = s.order as Order | null;
  if (s.result === 'needs_confirmation') {
    return (
      <Card title="Reorder?" icon={ShoppingBag} tone="warn">
        <p className="lead">{s.question}</p>
        <p className="muted">Say “yes” to start checkout.</p>
      </Card>
    );
  }
  if (s.result === 'declined') {
    return (
      <Card title="Refill" icon={ShoppingBag}>
        <p className="lead">Nothing ordered.</p>
      </Card>
    );
  }
  if (!o) {
    return (
      <Card title="Which medicine?" icon={ShoppingBag}>
        <Options options={s.options ?? []} />
      </Card>
    );
  }
  const placed = o.status === 'placed' || checkout === 'complete';
  return (
    <Card title="Refill order" icon={ShoppingBag} tone={placed ? 'ok' : undefined}>
      <p className="row-main">
        {o.name} <span className="muted">{o.strength}</span>
      </p>
      <p className="row-sub">
        {o.quantity} tablets · {o.pharmacy} · {o.fulfilment === 'delivery' ? 'home delivery' : 'pickup'}
      </p>
      <OrderSteps o={o} checkout={checkout} />
      {s.checkoutUrl && o.status === 'awaiting_checkout' && !checkout && (
        <a className="btn btn-secondary" href={s.checkoutUrl} target="_blank" rel="noopener noreferrer">
          Open secure checkout
        </a>
      )}
    </Card>
  );
}

/* ---------- doses logged ---------- */

function DoseLog({ s }: { s: Record<string, any> }) {
  const logged: any[] = s.logged ?? [];
  const already: any[] = s.alreadyLogged ?? [];
  if (s.result === 'needs_clarification' || s.result === 'not_found') {
    return (
      <Card title="Which medicine?" icon={Pill} tone="warn">
        <Options options={s.options ?? []} />
      </Card>
    );
  }
  return (
    <Card title={logged.length ? 'Doses logged' : 'Already logged'} icon={Check} tone={logged.length ? 'ok' : undefined}>
      <ul className="rows">
        {logged.map(l => (
          <li key={`${l.medicationId}-${l.slot}`} className={`dose dose-${l.status}`}>
            <StatusMark status={l.status} />
            <span className="dose-name">{l.name}</span>
            <span className="dose-meta">
              {l.slot} · {l.status === 'taken' ? 'taken' : 'skipped'}
            </span>
          </li>
        ))}
        {already.map(l => (
          <li key={`a-${l.medicationId}-${l.slot}`} className="dose dose-taken">
            <StatusMark status="taken" />
            <span className="dose-name">{l.name}</span>
            <span className="dose-meta">{l.slot} · already logged</span>
          </li>
        ))}
      </ul>
      {s.nextDose && (
        <ul className="facts">
          <Fact icon={Pill}>
            Next: <strong>{s.nextDose.name}</strong> at {clock(s.nextDose.time)}
          </Fact>
        </ul>
      )}
    </Card>
  );
}

/* ---------- wellbeing ---------- */

function Wellbeing({ s }: { s: Record<string, any> }) {
  if (s.redFlag) {
    return (
      <section className="card card-alert safety" role="alert" aria-label="Safety alert">
        <header className="card-head">
          <span className="card-icon" aria-hidden="true">
            <ShieldAlert />
          </span>
          <h3 className="card-title">Safety alert</h3>
          <span className="card-meta">{clock(s.time)}</span>
        </header>
        <p className="safety-what">{sentenceCase((s.reasons ?? []).join(', ') || 'urgent symptom')}</p>
        <ul className="facts">
          <Fact icon={Phone}>If it is severe or sudden, call emergency services now.</Fact>
          <Fact icon={Users}>The family has been told.</Fact>
        </ul>
      </section>
    );
  }
  return (
    <Card title="Note added" icon={NotebookPen} tone={s.severity === 'medium' ? 'warn' : undefined} meta={clock(s.time)}>
      <p className="lead">{sentenceCase(String(s.severity ?? ''))} concern</p>
      <p className="muted">The family will see it in today’s update.</p>
    </Card>
  );
}

/**
 * How the checkout link from this turn is being handled by a URL elicitation:
 * 'pending' while it's open or waiting, 'complete' once the server reports it done.
 */
export type CheckoutState = 'pending' | 'complete';

/** Picks the native card for a tool result. */
export function ResultCard({ result, checkout }: { result: ToolResult; checkout?: CheckoutState }) {
  if (result.isError) {
    return (
      <Card title="Couldn’t do that" icon={CircleAlert} tone="warn">
        <p className="lead">{result.text}</p>
      </Card>
    );
  }
  const s = result.structuredContent ?? {};
  switch (result.name) {
    case 'get_care_status':
      return <CareStatus s={s} />;
    case 'list_medications':
      return <Medications s={s} />;
    case 'check_refills':
      return <Refills s={s} />;
    case 'request_refill':
      return <RefillOrder s={s} checkout={checkout} />;
    case 'log_medication':
      return <DoseLog s={s} />;
    case 'log_wellbeing':
      return <Wellbeing s={s} />;
    default:
      return null;
  }
}
