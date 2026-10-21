import { useId, useState } from 'react';
import { CircleCheck, CircleX, ExternalLink, LoaderCircle, Lock, MessageCircleQuestion } from 'lucide-react';
import type { Elicitation, JsonSchemaProp } from './api';

export type ElicitationState = 'open' | 'sending' | 'accepted' | 'declined' | 'cancelled' | 'complete' | 'failed';

interface Props {
  e: Elicitation;
  state: ElicitationState;
  onAnswer: (action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) => void;
  onDismiss: () => void;
}

function initialValues(e: Elicitation): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(e.requestedSchema?.properties ?? {})) {
    if (p.default !== undefined) out[key] = p.default;
    else if (p.type === 'boolean') out[key] = false;
  }
  return out;
}

function choices(p: JsonSchemaProp): { value: string; label: string }[] | null {
  if (p.oneOf?.length) return p.oneOf.map(o => ({ value: o.const, label: o.title ?? o.const }));
  if (p.enum?.length) return p.enum.map(v => ({ value: v, label: v }));
  return null;
}

function Field({ name, p, value, onChange, required }: { name: string; p: JsonSchemaProp; value: unknown; onChange: (v: unknown) => void; required: boolean }) {
  const id = useId();
  const label = p.title ?? name;
  if (p.type === 'boolean') {
    return (
      <label className="field field-check" htmlFor={id}>
        <input id={id} type="checkbox" checked={value === true} onChange={ev => onChange(ev.target.checked)} />
        <span>{label}</span>
      </label>
    );
  }
  const opts = choices(p);
  if (opts) {
    return (
      <fieldset className="field">
        <legend>{label}</legend>
        <div className="radio-row">
          {opts.map(o => (
            <label key={o.value} className={`radio ${value === o.value ? 'radio-on' : ''}`}>
              <input type="radio" name={`${id}-${name}`} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  const numeric = p.type === 'number' || p.type === 'integer';
  return (
    <label className="field" htmlFor={id}>
      <span>
        {label}
        {required ? ' *' : ''}
      </span>
      <input
        id={id}
        type={numeric ? 'number' : 'text'}
        value={value === undefined ? '' : String(value)}
        min={p.minimum}
        max={p.maximum}
        onChange={ev => onChange(numeric ? Number(ev.target.value) : ev.target.value)}
      />
    </label>
  );
}

const DONE_TEXT: Partial<Record<ElicitationState, string>> = {
  accepted: 'Answered: yes',
  declined: 'Answered: no',
  cancelled: 'Cancelled',
  failed: 'This question expired before it was answered.'
};

export function ElicitationCard({ e, state, onAnswer, onDismiss }: Props) {
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(e));
  const busy = state === 'sending';
  const open = state === 'open' || busy;

  // An answered question folds to one line, so the reply's card stays in view.
  const folded = e.mode === 'url' ? ['complete', 'cancelled', 'failed', 'declined'].includes(state) : !open;
  if (folded) {
    const done = state === 'complete' || (e.mode === 'form' && state === 'accepted');
    return (
      <section className="dialog dialog-folded" aria-label={e.mode === 'url' ? 'Secure page request' : 'Question from CareCircle'}>
        <p className={`dialog-status${done ? ' dialog-done' : ''}`} role="status">
          {done ? <CircleCheck aria-hidden="true" /> : <CircleX aria-hidden="true" />}
          {e.mode === 'url' ? (state === 'complete' ? 'Checkout finished' : DONE_TEXT[state]) : DONE_TEXT[state]}
          <span className="dialog-folded-q">{e.mode === 'url' ? 'notifications/elicitation/complete' : e.message}</span>
        </p>
      </section>
    );
  }

  if (e.mode === 'url') {
    let host = '';
    try {
      host = new URL(e.url ?? '').host;
    } catch {
      /* ignore */
    }
    return (
      <section className={`dialog${open ? ' dialog-open' : ''}`} aria-label="Secure page request">
        <p className="dialog-kicker">
          <Lock aria-hidden="true" /> Secure page
        </p>
        <p className="dialog-question">{e.message}</p>
        <p className="dialog-note">Opens {host || 'a secure page'} in a new tab. The link is never spoken.</p>
        {open && (
          <div className="dialog-actions">
            <button
              type="button"
              className="btn btn-primary btn-big"
              disabled={busy}
              onClick={() => {
                if (e.url) window.open(e.url, '_blank', 'noopener,noreferrer');
                onAnswer('accept');
              }}
            >
              <ExternalLink aria-hidden="true" /> Open secure page
            </button>
            <button type="button" className="btn-text" disabled={busy} onClick={() => onAnswer('cancel')}>
              Cancel
            </button>
          </div>
        )}
        {state === 'accepted' && (
          <div className="dialog-actions">
            <p className="dialog-status dialog-waiting" role="status">
              <LoaderCircle aria-hidden="true" /> Waiting for checkout to finish…
            </p>
            <button type="button" className="btn-text" onClick={onDismiss}>
              Done
            </button>
          </div>
        )}
        {state === 'complete' && (
          <p className="dialog-status dialog-done" role="status">
            <CircleCheck aria-hidden="true" /> Checkout finished. The server sent notifications/elicitation/complete.
          </p>
        )}
        {(state === 'cancelled' || state === 'failed' || state === 'declined') && <p className="dialog-note">{DONE_TEXT[state]}</p>}
      </section>
    );
  }

  const props = e.requestedSchema?.properties ?? {};
  const required = e.requestedSchema?.required ?? [];
  return (
    <section className={`dialog${open ? ' dialog-open' : ''}`} aria-label="Question from CareCircle">
      <p className="dialog-kicker">
        <MessageCircleQuestion aria-hidden="true" /> Please confirm
      </p>
      <p className="dialog-question">{e.message}</p>
      {open ? (
        <form
          onSubmit={ev => {
            ev.preventDefault();
            onAnswer('accept', values);
          }}
        >
          {Object.entries(props).map(([name, p]) => (
            <Field key={name} name={name} p={p} value={values[name]} required={required.includes(name)} onChange={v => setValues(old => ({ ...old, [name]: v }))} />
          ))}
          <div className="dialog-actions">
            <button type="submit" className="btn btn-primary btn-big" disabled={busy}>
              Accept
            </button>
            <button type="button" className="btn btn-big" disabled={busy} onClick={() => onAnswer('decline')}>
              Decline
            </button>
            <button type="button" className="btn-text" disabled={busy} onClick={() => onAnswer('cancel')}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className={`dialog-status${state === 'accepted' ? ' dialog-done' : ''}`}>{DONE_TEXT[state] ?? ''}</p>
      )}
    </section>
  );
}
