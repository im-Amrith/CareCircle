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

const STATUS_LABEL: Record<string, string> = {
  taken: 'Taken',
  skipped: 'Skipped',
  due: 'Due now',
  upcoming: 'Later',
  missed: 'Missed'
};

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

function Card({ title, tone, children }: { title: string; tone?: 'warn' | 'alert' | 'ok'; children: React.ReactNode }) {
  return (
    <section className={`card ${tone ? `card-${tone}` : ''}`} aria-label={title}>
      <h3 className="card-title">{title}</h3>
      {children}
    </section>
  );
}

/* ---------- cards ---------- */

function CareStatus({ s }: { s: Record<string, any> }) {
  const doses: any[] = s.doses ?? [];
  return (
    <Card title={`${s.recipient?.name ?? 'Today'} · ${day(s.date)}`}>
      <div className="big-stat">
        <span className="big-num">
          {s.counts?.taken ?? 0}/{s.counts?.total ?? 0}
        </span>
        <span className="big-label">doses taken</span>
      </div>
      <ul className="chips" aria-label="Today's doses">
        {doses.map(d => (
          <li key={`${d.medicationId}-${d.slot}`} className={`chip chip-${d.status}`}>
            <span className="chip-name">{d.name}</span>
            <span className="chip-meta">
              {clock(d.time)} · {STATUS_LABEL[d.status] ?? d.status}
            </span>
          </li>
        ))}
      </ul>
      <dl className="facts">
        {s.nextDose && (
          <>
            <dt>Next</dt>
            <dd>
              {s.nextDose.name} at {clock(s.nextDose.time)}
            </dd>
          </>
        )}
        {(s.visits ?? []).map((v: any) => (
          <FactPair key={`${v.who}-${v.time}`} label="Visit" value={`${v.who} at ${clock(v.time)}`} />
        ))}
        {s.latestWellbeing && (
          <FactPair label={s.latestWellbeing.redFlag ? 'Alert' : 'Note'} value={s.latestWellbeing.note} alert={s.latestWellbeing.redFlag} />
        )}
        {(s.refillAlerts ?? []).map((a: any) => (
          <FactPair
            key={a.medicationId}
            label="Supply"
            value={`${a.name}: ${a.daysLeft} days left${a.order ? ` · ${orderLine(a.order)}` : ''}`}
            alert={!a.order}
          />
        ))}
      </dl>
    </Card>
  );
}

function FactPair({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={alert ? 'fact-alert' : undefined}>{value}</dd>
    </>
  );
}

function Medications({ s }: { s: Record<string, any> }) {
  const meds: any[] = s.medications ?? [];
  return (
    <Card title={s.when ? `${s.when[0].toUpperCase()}${s.when.slice(1)} medicines` : 'Medicines'}>
      <ul className="rows">
        {meds.map(m => (
          <li key={m.id} className="row">
            <div>
              <div className="row-main">
                {m.name} <span className="muted">{m.strength}</span>
              </div>
              <div className="row-sub">
                {m.purpose} · {m.schedule.map((x: any) => `${clock(x.time)}${x.instructions ? ` ${x.instructions}` : ''}`).join(', ')}
              </div>
            </div>
            <div className={`pill ${m.daysLeft <= 7 ? 'pill-warn' : ''}`}>{m.daysLeft} days</div>
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
      <Card title="Supplies" tone="ok">
        <p className="lead">Everything has more than {s.withinDays} days left.</p>
      </Card>
    );
  }
  return (
    <Card title="Running low" tone={alerts.some(a => !a.order) ? 'warn' : undefined}>
      <ul className="rows">
        {alerts.map(a => (
          <li key={a.medicationId} className="row">
            <div>
              <div className="row-main">
                {a.name} <span className="muted">{a.strength}</span>
              </div>
              <div className="row-sub">
                {a.pillsOnHand} left · runs out {day(a.runsOutOn)} · {a.pharmacy?.name}
              </div>
              {a.order && <div className="row-status">{orderLine(a.order)}</div>}
            </div>
            <div className="pill pill-warn">{a.daysLeft} days</div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function RefillOrder({ s, checkout }: { s: Record<string, any>; checkout?: CheckoutState }) {
  const o = s.order as Order | null;
  if (s.result === 'needs_confirmation') {
    return (
      <Card title="Reorder?" tone="warn">
        <p className="lead">{s.question}</p>
        <p className="muted">Say “yes” to start checkout.</p>
      </Card>
    );
  }
  if (s.result === 'declined') {
    return (
      <Card title="Refill">
        <p className="lead">Nothing ordered.</p>
      </Card>
    );
  }
  if (!o) {
    return (
      <Card title="Refill">
        <p className="lead">Which medicine?</p>
        <ul className="chips">
          {(s.options ?? []).map((x: any) => (
            <li key={x.id} className="chip">
              <span className="chip-name">{x.name}</span>
              <span className="chip-meta">{x.purpose}</span>
            </li>
          ))}
        </ul>
      </Card>
    );
  }
  return (
    <Card title="Refill order" tone={o.status === 'placed' ? 'ok' : undefined}>
      <div className="row-main">
        {o.name} <span className="muted">{o.strength}</span>
      </div>
      <p className="row-sub">
        {o.quantity} tablets · {o.pharmacy} · {o.fulfilment === 'delivery' ? 'home delivery' : 'pickup'}
      </p>
      {checkout === 'complete' ? (
        <p className="status-line status-placed">Checkout finished</p>
      ) : (
        <p className={`status-line status-${o.status}`}>{orderLine(o)}</p>
      )}
      {s.checkoutUrl && o.status === 'awaiting_checkout' && !checkout && (
        <a className="btn btn-secondary" href={s.checkoutUrl} target="_blank" rel="noopener noreferrer">
          Open secure checkout
        </a>
      )}
    </Card>
  );
}

function DoseLog({ s }: { s: Record<string, any> }) {
  const logged: any[] = s.logged ?? [];
  const already: any[] = s.alreadyLogged ?? [];
  if (s.result === 'needs_clarification' || s.result === 'not_found') {
    return (
      <Card title="Which medicine?" tone="warn">
        <ul className="chips">
          {(s.options ?? []).map((x: any) => (
            <li key={x.id} className="chip">
              <span className="chip-name">{x.name}</span>
              <span className="chip-meta">{x.purpose}</span>
            </li>
          ))}
        </ul>
      </Card>
    );
  }
  return (
    <Card title="Doses logged" tone={logged.length ? 'ok' : undefined}>
      <ul className="chips">
        {logged.map(l => (
          <li key={`${l.medicationId}-${l.slot}`} className={`chip chip-${l.status}`}>
            <span className="chip-name">{l.name}</span>
            <span className="chip-meta">
              {l.slot} · {l.status === 'taken' ? 'Taken' : 'Skipped'}
            </span>
          </li>
        ))}
        {already.map(l => (
          <li key={`a-${l.medicationId}-${l.slot}`} className="chip chip-taken">
            <span className="chip-name">{l.name}</span>
            <span className="chip-meta">{l.slot} · already logged</span>
          </li>
        ))}
      </ul>
      {s.nextDose && (
        <p className="row-sub">
          Next: {s.nextDose.name} at {clock(s.nextDose.time)}
        </p>
      )}
    </Card>
  );
}

function Wellbeing({ s }: { s: Record<string, any> }) {
  if (s.redFlag) {
    return (
      <Card title="Safety alert" tone="alert">
        <p className="lead">{sentenceCase((s.reasons ?? []).join(', ') || 'urgent symptom')} noted at {clock(s.time)}.</p>
        <p>If it is severe or sudden, call emergency services now. The family has been flagged.</p>
      </Card>
    );
  }
  return (
    <Card title="Note added" tone={s.severity === 'medium' ? 'warn' : undefined}>
      <p className="lead">
        {clock(s.time)} · {s.severity} concern
      </p>
      <p className="muted">Visible to the family in today's update.</p>
    </Card>
  );
}

const sentenceCase = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * How the checkout link from this turn is being handled by a URL elicitation:
 * 'pending' while it's open or waiting, 'complete' once the server reports it done.
 */
export type CheckoutState = 'pending' | 'complete';

/** Picks the native card for a tool result. */
export function ResultCard({ result, checkout }: { result: ToolResult; checkout?: CheckoutState }) {
  if (result.isError) {
    return (
      <Card title="Couldn't do that" tone="warn">
        <p className="lead">{result.text}</p>
      </Card>
    );
  }
  const s = result.structuredContent ?? {};
  let card: React.ReactNode = null;
  switch (result.name) {
    case 'get_care_status':
      card = <CareStatus s={s} />;
      break;
    case 'list_medications':
      card = <Medications s={s} />;
      break;
    case 'check_refills':
      card = <Refills s={s} />;
      break;
    case 'request_refill':
      card = <RefillOrder s={s} checkout={checkout} />;
      break;
    case 'log_medication':
      card = <DoseLog s={s} />;
      break;
    case 'log_wellbeing':
      card = <Wellbeing s={s} />;
      break;
  }
  return card;
}
