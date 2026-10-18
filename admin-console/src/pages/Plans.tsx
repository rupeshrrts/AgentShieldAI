import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { formatMoney, planDuration } from '../format';
import { Alert, PageHead, Pill } from '../ui';
import type { Plan } from '../types';

type Draft = {
  name?: string; device_limit?: string; price?: string; currency?: string; purchasable?: boolean; active?: boolean;
  features?: string; duration_days?: string; credits?: string; check_limit?: string;
};

/** Plan names, prices, browser limits and availability. Only the platform owner can change them. */
export const Plans: React.FC<{ can: (p: string) => boolean }> = ({ can }) => {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const editable = can('plans.manage');
  const load = () => api.plans().then((p) => { setPlans(p); setDraft({}); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const set = (code: string, key: keyof Draft, value: string | boolean) => setDraft((d) => ({ ...d, [code]: { ...d[code], [key]: value } }));

  const save = async (p: Plan) => {
    const d = draft[p.code] || {};
    const updates: Partial<Plan> = {};
    if (d.name !== undefined) updates.name = d.name;
    if (d.device_limit !== undefined) updates.device_limit = Number(d.device_limit);
    if (d.price !== undefined && d.price !== '') updates.price_minor = Math.round(Number(d.price) * 100);
    if (d.currency !== undefined) updates.currency = d.currency.toUpperCase();
    if (d.purchasable !== undefined) updates.purchasable = d.purchasable;
    if (d.active !== undefined) updates.active = d.active;
    if (d.features !== undefined) updates.features = d.features.split('\n');
    if (p.kind === 'TRIAL' && d.duration_days !== undefined) updates.duration_days = Number(d.duration_days);
    if (p.kind === 'CREDITS' && d.credits !== undefined) updates.credits = Number(d.credits);
    // 0 or empty = unlimited
    if ((p.kind === 'TRIAL' || p.kind === 'PAID' || p.kind === 'FREE') && d.check_limit !== undefined) updates.check_limit = Number(d.check_limit || 0);
    setError('');
    try {
      await api.updatePlan(p.code, updates);
      setNotice(`${p.name} saved.`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    }
  };

  return (
    <div className="stack">
      <PageHead title="Plans & pricing" sub={editable ? 'Prices in the currency’s main unit (499 = ₹499). A plan can be sold only with a price. Changing the monthly price creates a new Razorpay plan for new subscriptions.' : 'Read-only: only the platform owner can change plans.'} />
      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{notice}</Alert>
      <div className="grid-kpi" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))' }}>
        {plans.map((p) => {
          const d = draft[p.code] || {};
          return (
            <section key={p.code} className="card card-pad stack" style={{ gap: 10 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="tag">{p.code}</span>
                <span className="cell-sub">{p.kind.toLowerCase()} · {p.kind === 'FREE' ? 'forever, never sold' : planDuration(p)}</span>
              </div>
              <div className="row">
                <strong>{p.name}</strong>
                {p.purchasable ? <Pill tone="ok">for sale {formatMoney(p.price_minor, p.currency)}</Pill> : <Pill tone="muted">not for sale</Pill>}
              </div>
              {editable && (
                <>
                  <label className="label">Name<input className="input" defaultValue={p.name} onChange={(e) => set(p.code, 'name', e.target.value)} /></label>
                  {p.kind === 'TRIAL' && <label className="label">Trial length (days)<input className="input" type="number" min={1} defaultValue={p.duration_days ?? 30} onChange={(e) => set(p.code, 'duration_days', e.target.value)} /></label>}
                  <label className="label">Browser limit<input className="input" type="number" min={1} defaultValue={p.device_limit} onChange={(e) => set(p.code, 'device_limit', e.target.value)} /></label>
                  {p.kind === 'CREDITS' && (
                    <label className="label">Prompt checks per pack<input className="input" type="number" min={1} defaultValue={p.credits ?? ''} onChange={(e) => set(p.code, 'credits', e.target.value)} /></label>
                  )}
                  {p.kind === 'FREE' && (
                    <label className="label">Free prompt checks per month (individual accounts with a confirmed email)
                      <input className="input" type="number" min={1} defaultValue={p.check_limit ?? 300} onChange={(e) => set(p.code, 'check_limit', e.target.value)} />
                    </label>
                  )}
                  {(p.kind === 'TRIAL' || p.kind === 'PAID') && (
                    <label className="label">Included prompt checks per month (empty = unlimited)
                      <input className="input" type="number" min={0} placeholder="unlimited" defaultValue={p.check_limit ?? ''} onChange={(e) => set(p.code, 'check_limit', e.target.value)} />
                    </label>
                  )}
                  {(p.kind === 'PAID' || p.kind === 'CREDITS') && (
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <label className="label" style={{ flex: 1 }}>Price<input className="input" type="number" min={0} step="0.01" placeholder="not set" defaultValue={p.price_minor ? p.price_minor / 100 : ''} onChange={(e) => set(p.code, 'price', e.target.value)} /></label>
                      <label className="label" style={{ width: 84 }}>Currency<input className="input" maxLength={3} defaultValue={p.currency} onChange={(e) => set(p.code, 'currency', e.target.value)} /></label>
                    </div>
                  )}
                  <label className="label">Features (one per line)<textarea className="input" rows={3} defaultValue={p.features.join('\n')} onChange={(e) => set(p.code, 'features', e.target.value)} /></label>
                  <label className="row" style={{ fontSize: 13 }}><input type="checkbox" defaultChecked={p.active} onChange={(e) => set(p.code, 'active', e.target.checked)} /> Available</label>
                  {(p.kind === 'PAID' || p.kind === 'CREDITS') && <label className="row" style={{ fontSize: 13 }}><input type="checkbox" defaultChecked={p.purchasable} onChange={(e) => set(p.code, 'purchasable', e.target.checked)} /> Offered for sale</label>}
                  <button type="button" className="btn btn-primary" disabled={!draft[p.code]} onClick={() => save(p)}>Save {d.name || p.name}</button>
                </>
              )}
              {!editable && (
                <div className="cell-sub">
                  {p.kind === 'CREDITS' ? `${(p.credits ?? 0).toLocaleString()} prompt checks per pack` : `Up to ${p.device_limit} browsers`}
                  {p.check_limit ? ` · ${p.check_limit.toLocaleString()} checks/month` : ''} · {p.features.join(' · ')}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
};
