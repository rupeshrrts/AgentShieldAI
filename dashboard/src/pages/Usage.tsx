import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Activity, Coins, Gauge, ShoppingCart } from 'lucide-react';
import { SectionHeader } from '../components/SectionHeader';
import { NavTab } from '../components/Sidebar';
import { api } from '../services/api';
import { CreditLedgerEntry, UsageSummary } from '../types';
import { STATE_CLASS, STATE_LABEL, formatDate, formatNumber } from '../utils/format';

const KIND_LABEL: Record<string, string> = {
  purchase: 'Purchase', grant: 'Added by AgentShield', refund: 'Refund', dispute: 'Payment disputed',
  dispute_won: 'Dispute resolved', adjust: 'Adjustment',
};

/**
 * Usage and credits: what the account has used (prompt checks), what is included in the plan,
 * the prepaid credit balance and history, and the account's own monthly limit. Every number
 * comes from the server (usage is metered from the extension's authenticated reports).
 */
export const Usage: React.FC<{ isAdmin: boolean; onNavigate: (tab: NavTab) => void }> = ({ isAdmin, onNavigate }) => {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [ledger, setLedger] = useState<{ balance: number; used_total: number; entries: CreditLedgerEntry[] } | null>(null);
  const [days, setDays] = useState(30);
  const [cap, setCap] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    try {
      const [u, l] = await Promise.all([api.getUsage(days), api.getCreditLedger()]);
      setUsage(u);
      setLedger(l);
      setCap(u.entitlement.monthly_cap ? String(u.entitlement.monthly_cap) : '');
    } catch (e: any) {
      setError(e.message);
    }
  };
  useEffect(() => { load(); }, [days]);

  const saveCap = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      const value = cap.trim() === '' ? null : Math.max(0, Math.floor(Number(cap)));
      await api.setMonthlyCap(value || null);
      setNotice(value ? `Monthly limit set to ${value.toLocaleString()} prompt checks.` : 'Monthly limit removed.');
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (!usage) return <div className="empty-state"><p>{error || 'Loading usage...'}</p></div>;
  const ent = usage.entitlement;
  const max = Math.max(1, ...usage.daily.map((d) => d.prompt_checks));
  const included = ent.check_limit ?? null;
  const usedIncluded = ent.included_checks_used ?? 0;
  const isFree = ent.state === 'FREE_ACTIVE' || ent.state === 'FREE_PAUSED';
  const resets = ent.resets_at ? formatDate(ent.resets_at) : 'the 1st of next month';

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 className="page-title">Usage &amp; credits</h1>
        <p className="page-subtitle">You are billed per <strong>prompt check</strong>: one prompt AgentShield inspected on an AI site. Website blocks and files are not counted.</p>
      </div>
      {error && <div className="callout callout-error">{error}</div>}
      {notice && <div className="callout callout-success">{notice}</div>}
      {ent.state === 'FREE_PAUSED' && (
        <div className="callout callout-warning" role="status">
          Protection paused: this month's {formatNumber(included)} free prompt checks are used. AI sites and website controls keep
          working, but prompts are not checked until {resets}. Upgrade or buy credits on Account &amp; plan to resume now.
        </div>
      )}

      <div className="kpi-grid">
        <div className="glass-panel kpi-tile">
          <div className="kpi-label"><Activity size={14} /> Prompt checks this month</div>
          <div className="kpi-value">{formatNumber(ent.checks_this_month)}</div>
          <div className="kpi-sub">Since {formatDate(usage.month_start)} (UTC)</div>
        </div>
        <div className="glass-panel kpi-tile">
          <div className="kpi-label"><Gauge size={14} /> {isFree ? 'Free checks this month' : 'Included in your plan'}</div>
          <div className="kpi-value">{included === null ? (ent.state === 'CREDITS_ACTIVE' ? '—' : 'Unlimited') : `${formatNumber(usedIncluded)} / ${formatNumber(included)}`}</div>
          <div className="kpi-sub">{isFree ? `Resets ${resets} · then credits, if you have any` : included !== null ? 'Extra checks use credits' : ent.state === 'CREDITS_ACTIVE' ? 'No plan: every check uses a credit' : 'No monthly limit on your plan'}</div>
          {included !== null && <div className="meter"><div style={{ width: `${Math.min(100, (usedIncluded / Math.max(1, included)) * 100)}%` }} /></div>}
        </div>
        <div className="glass-panel kpi-tile">
          <div className="kpi-label"><Coins size={14} /> Prepaid credits</div>
          <div className="kpi-value">{formatNumber(ent.credit_balance)}</div>
          <div className="kpi-sub">1 credit = 1 prompt check · never expire</div>
        </div>
        <div className="glass-panel kpi-tile">
          <div className="kpi-label">Status</div>
          <div style={{ marginTop: 8 }}><span className={`status-pill ${STATE_CLASS[ent.state]}`}><span className="status-dot" /> {STATE_LABEL[ent.state] || ent.state}</span></div>
          <div className="kpi-sub" style={{ marginTop: 8 }}>{ent.pay_with_credits ? 'New checks are paid with credits' : ['TRIAL_ACTIVE', 'SUBSCRIPTION_ACTIVE', 'FREE_ACTIVE'].includes(ent.state) ? 'Covered by your plan' : ent.state === 'FREE_PAUSED' ? `Prompt checks paused until ${resets}` : 'Browsers are locked'}</div>
        </div>
      </div>

      <section className="glass-panel" style={{ padding: 24 }}>
        <SectionHeader icon={<Activity size={18} />} title="Daily prompt checks"
          right={
            <div className="seg" role="tablist">
              {[7, 30, 90].map((d) => <button key={d} type="button" className={days === d ? 'active' : ''} onClick={() => setDays(d)}>{d} days</button>)}
            </div>
          }>
          {formatNumber(usage.totals.prompt_checks)} checks in the last {days} days · {formatNumber(usage.totals.blocked)} blocked · {formatNumber(usage.totals.warned)} warned · {formatNumber(usage.totals.redacted)} redacted · {formatNumber(usage.totals.credit_checks)} paid with credits
        </SectionHeader>
        {usage.totals.prompt_checks === 0 ? (
          <div className="empty-state" style={{ padding: '32px 12px' }}>
            <h3>No prompt checks yet</h3>
            <p>Usage appears once a connected browser sends prompts on an AI site.</p>
          </div>
        ) : (
          <div className="bar-chart" role="img" aria-label={`Daily prompt checks, last ${days} days`}>
            {usage.daily.map((d) => (
              <div key={d.day} className="bar-col" title={`${d.day}: ${d.prompt_checks} checks (${d.credit_checks} with credits)`}>
                <div className="bar" style={{ height: `${(d.prompt_checks / max) * 100}%` }}>
                  {d.credit_checks > 0 && <div className="bar-credit" style={{ height: `${(d.credit_checks / Math.max(1, d.prompt_checks)) * 100}%` }} />}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="chart-legend"><span><i className="sw sw-plan" /> Covered by plan</span><span><i className="sw sw-credit" /> Paid with credits</span></div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 20 }}>
        <section className="glass-panel" style={{ padding: 24 }}>
          <SectionHeader icon={<Gauge size={18} />} title="Monthly usage limit">
            Stop protection (and spending) after this many prompt checks per calendar month. Leave empty for no limit.
          </SectionHeader>
          <form onSubmit={saveCap} className="row-form">
            <input className="input" type="number" min={0} placeholder="No limit" value={cap} onChange={(e) => setCap(e.target.value)}
              disabled={!isAdmin} aria-label="Monthly prompt-check limit" style={{ maxWidth: 200 }} />
            <button className="btn-primary" type="submit" disabled={!isAdmin}>Save</button>
          </form>
          {ent.monthly_cap ? <p className="cell-sub" style={{ marginTop: 8 }}>{formatNumber(ent.checks_this_month)} of {formatNumber(ent.monthly_cap)} used this month.</p> : null}
        </section>

        <section className="glass-panel" style={{ padding: 24 }}>
          <SectionHeader icon={<Coins size={18} />} title="Credit history"
            right={<button type="button" className="btn-secondary btn-sm" onClick={() => onNavigate('account')}><ShoppingCart size={13} /> Buy credits</button>}>
            {formatNumber(ledger?.used_total)} credits used in total.
          </SectionHeader>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Date</th><th>What</th><th style={{ textAlign: 'right' }}>Credits</th><th style={{ textAlign: 'right' }}>Balance</th></tr></thead>
              <tbody>
                {(!ledger || ledger.entries.length === 0) && <tr><td colSpan={4} className="empty-cell">No credit purchases yet.</td></tr>}
                {ledger?.entries.map((e, i) => (
                  <tr key={i}>
                    <td>{formatDate(e.created_at)}</td>
                    <td>{KIND_LABEL[e.kind] || e.kind}<div className="cell-sub">{e.note}</div></td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: e.delta >= 0 ? 'var(--color-success-text)' : 'var(--color-danger-text)' }}>{e.delta >= 0 ? '+' : ''}{formatNumber(e.delta)}</td>
                    <td style={{ textAlign: 'right' }}>{formatNumber(e.balance_after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </motion.div>
  );
};
