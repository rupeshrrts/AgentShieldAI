import React, { useState } from 'react';
import { STATE_LABEL, STATE_TONE } from './format';
import type { Entitlement } from './types';

/** Page header used by every page. */
export const PageHead: React.FC<{ title: string; sub?: string; right?: React.ReactNode }> = ({ title, sub, right }) => (
  <div className="topbar">
    <div>
      <div className="row"><h1 className="page-title">{title}</h1><span className="internal-badge">INTERNAL</span></div>
      {sub && <p className="page-sub">{sub}</p>}
    </div>
    {right}
  </div>
);

export const Pill: React.FC<{ tone: string; children: React.ReactNode }> = ({ tone, children }) => <span className={`pill ${tone}`}>{children}</span>;

/** Entitlement state as a pill; internal (not-for-sale) licences are shown as such. */
export const StatePill: React.FC<{ ent: Entitlement }> = ({ ent }) => {
  const state = ent.kind === 'INTERNAL' && ent.state === 'SUBSCRIPTION_ACTIVE' ? 'INTERNAL' : ent.state;
  return <Pill tone={STATE_TONE[state] || 'muted'}>{STATE_LABEL[state] || state}</Pill>;
};

export const Alert: React.FC<{ kind: 'error' | 'success' | 'info'; children: React.ReactNode }> = ({ kind, children }) =>
  children ? <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div> : null;

export interface PromptField {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'password' | 'select';
  options?: { value: string; label: string }[];
  initial?: string;
  minLength?: number;
  placeholder?: string;
}

/**
 * Confirmation dialog with optional fields (e.g. a required reason). Destructive actions always go through it.
 */
export const Dialog: React.FC<{
  title: string;
  message?: React.ReactNode;
  fields?: PromptField[];
  confirmLabel: string;
  danger?: boolean;
  onConfirm: (values: Record<string, string>) => Promise<void> | void;
  onClose: () => void;
}> = ({ title, message, fields = [], confirmLabel, danger, onConfirm, onClose }) => {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, f.initial ?? ''])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const invalid = fields.some((f) => (values[f.name] || '').trim().length < (f.minLength ?? 0));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onConfirm(values);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" onSubmit={submit}>
        <h2>{title}</h2>
        {message && <div className="card-note">{message}</div>}
        {fields.map((f) => (
          <div key={f.name}>
            <label className="label" htmlFor={`dlg-${f.name}`}>{f.label}</label>
            {f.type === 'select' ? (
              <select id={`dlg-${f.name}`} className="select" value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
                {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input id={`dlg-${f.name}`} className="input" type={f.type || 'text'} value={values[f.name]} placeholder={f.placeholder}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} autoFocus={f === fields[0]} />
            )}
          </div>
        ))}
        <Alert kind="error">{error}</Alert>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy || invalid}>{busy ? 'Working...' : confirmLabel}</button>
        </div>
      </form>
    </div>
  );
};

export type OpenDialog = (d: Omit<React.ComponentProps<typeof Dialog>, 'onClose'>) => void;
