import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api';
import { formatMoney } from '../format';
import { Alert, PageHead, type OpenDialog } from '../ui';
import type { Analytics, Metrics } from '../types';
import { ACTION_COLORS, BarList, DonutChart, SERIES, Slice, StackedColumns } from '../charts';

// Fixed order and colour per plan state (colour follows the state, never its rank)
const PLAN_SLICES: Array<{ label: string; states: string[]; color: string }> = [
  { label: 'Free trial', states: ['TRIAL_ACTIVE'], color: SERIES[0] },
  { label: 'Paid', states: ['SUBSCRIPTION_ACTIVE'], color: SERIES[2] },
  { label: 'Free plan', states: ['FREE_ACTIVE', 'FREE_PAUSED'], color: SERIES[6] },
  { label: 'Pay as you go', states: ['CREDITS_ACTIVE'], color: SERIES[3] },
  { label: 'Locked by usage', states: ['LIMIT_REACHED', 'CAP_REACHED', 'NO_CREDITS'], color: SERIES[1] },
  { label: 'Expired / no plan', states: ['EXPIRED', 'NONE'], color: '#94a3b8' },
  { label: 'Suspended / revoked', states: ['SUSPENDED', 'REVOKED'], color: SERIES[7] },
  { label: 'Internal', states: ['INTERNAL'], color: SERIES[4] },
];
const CATEGORY_ORDER = ['SECRET', 'PII', 'RESTRICTED', 'FILE', 'UNAUTHORIZED_TOOL', 'WEB_FILTER', 'PROMPT_LOG'];
const CATEGORY_LABELS: Record<string, string> = {
  SECRET: 'Credentials & keys', PII: 'Personal data', RESTRICTED: 'Confidential keywords', FILE: 'File uploads',
  UNAUTHORIZED_TOOL: 'Blocked websites', WEB_FILTER: 'Blocked website categories', PROMPT_LOG: 'Clean prompts',
};
const ROLE_LABELS: Record<string, string> = { ADMIN: 'Account owners / admins', VIEWER: 'Viewers', EMPLOYEE: 'Employees' };
const RANGES = [7, 30, 90];

const Panel: React.FC<{ title: string; hint?: string; children: React.ReactNode }> = ({ title, hint, children }) => (
  <section className="card card-pad">
    <div className="card-head" style={{ marginBottom: 14 }}>
      <div className="card-title">{title}</div>
      {hint && <span className="card-note">{hint}</span>}
    </div>
    {children}
  </section>
);
const Empty: React.FC<{ text?: string }> = ({ text = 'No data yet.' }) => <div className="card-note">{text}</div>;

/** Platform KPIs and trends. Every number comes from /internal/api/metrics and /internal/api/analytics. */
export const Overview: React.FC<{ can: (p: string) => boolean; openDialog: OpenDialog }> = ({ can, openDialog }) => {
  const [m, setM] = useState<Metrics | null>(null);
  const [a, setA] = useState<Analytics | null>(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = () => api.metrics().then(setM).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => { api.analytics(days).then(setA).catch((e) => setError(e.message)); }, [days]);

  const money = (r?: Record<string, number>) =>
    r && Object.keys(r).length ? Object.entries(r).map(([c, v]) => formatMoney(v, c)).join(' · ') : '—';

  const hero = m ? [
    { label: 'Customer accounts', value: m.companies.toLocaleString(), sub: `${(m.accounts_by_type?.INDIVIDUAL ?? 0).toLocaleString()} individual · ${(m.accounts_by_type?.COMPANY ?? 0).toLocaleString()} company` },
    { label: 'Users', value: m.accounts.toLocaleString(), sub: a ? `${a.individual_owners.verified} confirmed · ${a.individual_owners.unverified} unconfirmed individual owners` : 'All customer user accounts' },
    { label: 'Active browsers', value: m.active_devices.toLocaleString(), sub: `${m.licensed_devices_used} / ${m.licensed_device_capacity} licensed browser slots in use` },
    { label: 'Prompt checks this month', value: (m.prompt_checks_this_month ?? 0).toLocaleString(), sub: `${(m.credit_checks_this_month ?? 0).toLocaleString()} paid with credits` },
    { label: 'Net revenue this month', value: money(m.net_revenue_this_month), sub: 'Captured payments minus refunds (UTC month)' },
    {
      label: 'Trial → paid', value: m.trials_claimed ? `${Math.round((m.trial_conversions / m.trials_claimed) * 100)}%` : '—',
      sub: `${m.trial_conversions} of ${m.trials_claimed} trials claimed`,
    },
  ] : [];

  const planSlices: Slice[] = m
    ? PLAN_SLICES.map((p) => ({ label: p.label, value: p.states.reduce((n, s) => n + (m.by_state[s] || 0), 0), color: p.color })).filter((s) => s.value > 0)
    : [];
  const typeSlices: Slice[] = m ? [
    { label: 'Individual', value: m.accounts_by_type?.INDIVIDUAL ?? 0, color: SERIES[0] },
    { label: 'Company', value: m.accounts_by_type?.COMPANY ?? 0, color: SERIES[1] },
  ].filter((s) => s.value > 0) : [];
  const actionSlices: Slice[] = a ? [
    { label: 'Blocked', value: a.actions.BLOCK || 0, color: ACTION_COLORS.BLOCK },
    { label: 'Warned', value: a.actions.WARN || 0, color: ACTION_COLORS.WARN },
    { label: 'Redacted', value: a.actions.REDACT || 0, color: ACTION_COLORS.REDACT },
    { label: 'Monitored', value: a.actions.MONITOR || 0, color: ACTION_COLORS.MONITOR },
    { label: 'Allowed', value: a.actions.ALLOW || 0, color: ACTION_COLORS.ALLOW },
  ].filter((s) => s.value > 0) : [];
  const categorySlices: Slice[] = a ? [
    ...CATEGORY_ORDER.map((c, i) => ({ label: CATEGORY_LABELS[c], value: a.categories[c] || 0, color: SERIES[i] })),
    { label: 'Other', value: Object.entries(a.categories).filter(([c]) => !CATEGORY_ORDER.includes(c)).reduce((n, [, v]) => n + v, 0), color: SERIES[7] },
  ].filter((s) => s.value > 0) : [];
  const browserOrder = ['Chrome', 'Edge', 'Brave', 'Opera', 'Chromium', 'Other'];
  const browserSlices: Slice[] = a
    ? browserOrder.map((b, i) => ({ label: b, value: a.browsers[b] || 0, color: SERIES[i] })).filter((s) => s.value > 0)
    : [];
  const rows = (r: Record<string, number>, labels: Record<string, string> = {}) =>
    Object.entries(r).sort((x, y) => y[1] - x[1]).map(([k, v]) => ({ label: labels[k] || k, value: v }));
  const checksRows = a ? a.checks_daily.map((d) => ({ ...d, other: Math.max(0, d.prompt_checks - d.blocked - d.warned - d.redacted) })) : [];
  const anySignups = a ? a.signups_daily.some((d) => d.individual + d.company > 0) : false;
  const anyChecks = checksRows.some((d) => d.prompt_checks > 0);

  const tiles = m ? [
    { label: 'Trials active', value: m.by_state.TRIAL_ACTIVE || 0, def: 'Accounts whose best current licence is a trial.' },
    { label: 'Paid active', value: m.by_state.SUBSCRIPTION_ACTIVE || 0, def: 'Accounts with a current paid licence (internal licences excluded).' },
    { label: 'Free plan', value: (m.by_state.FREE_ACTIVE || 0) + (m.by_state.FREE_PAUSED || 0), def: 'Confirmed individual accounts with no live licence; includes those paused this month.' },
    { label: 'Pay as you go', value: m.by_state.CREDITS_ACTIVE || 0, def: 'Accounts without a licence, running on prepaid credits.' },
    { label: 'Locked by usage', value: (m.by_state.LIMIT_REACHED || 0) + (m.by_state.CAP_REACHED || 0) + (m.by_state.NO_CREDITS || 0), def: 'Plan checks used up, own limit reached, or credits used up.' },
    { label: 'Expired', value: m.by_state.EXPIRED || 0, def: 'Accounts whose licences have all ended.' },
    { label: 'Suspended', value: m.by_state.SUSPENDED || 0, def: 'Accounts suspended by AgentShieldAI.' },
    { label: 'Trials claimed', value: m.trials_claimed, def: 'Free trials ever claimed (one per account and person).' },
    { label: 'Credits outstanding', value: (m.credits_outstanding ?? 0).toLocaleString(), def: 'Unused prepaid credits across all accounts (a liability).' },
    { label: 'Credits sold this month', value: (m.credits_sold_this_month ?? 0).toLocaleString(), def: 'Credits added by verified purchases since the 1st (UTC).' },
    { label: 'Referrals rewarded', value: a ? (a.referrals.REWARDED || 0) : '—', def: `Invited accounts that confirmed their email${a ? ` (${a.referrals.PENDING || 0} pending)` : ''}.` },
  ] : [];

  return (
    <div className="stack">
      <PageHead title="Overview" sub="Platform-wide figures and trends from live data. Counts only: no prompt text, sites or customer email addresses." />
      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{notice}</Alert>
      {!m && !error && <div className="card card-pad card-note">Loading...</div>}

      <div className="grid-hero">
        {hero.map((t) => (
          <div key={t.label} className="card kpi kpi-hero">
            <div className="kpi-label">{t.label}</div>
            <div className="kpi-value">{t.value}</div>
            <div className="kpi-def">{t.sub}</div>
          </div>
        ))}
      </div>

      <div className="range-row">
        <span className="card-note">Trends for the last</span>
        {RANGES.map((r) => (
          <button key={r} type="button" className={`btn btn-sm ${days === r ? 'btn-primary' : ''}`} onClick={() => setDays(r)}>{r} days</button>
        ))}
        <span className="card-note">(UTC days)</span>
      </div>

      <div className="grid-charts">
        <Panel title="New sign-ups" hint={a ? `${a.signups_daily.reduce((n, d) => n + d.individual + d.company, 0)} in ${days} days` : undefined}>
          {a && anySignups ? (
            <StackedColumns rows={a.signups_daily} xKey="day" series={[
              { key: 'individual', label: 'Individual', color: SERIES[0] },
              { key: 'company', label: 'Company', color: SERIES[1] },
            ]} />
          ) : <Empty text={a ? 'No sign-ups in this period.' : 'Loading...'} />}
        </Panel>
        <Panel title="Prompt checks per day" hint="Metered checks from activated browsers">
          {a && anyChecks ? (
            <StackedColumns rows={checksRows} xKey="day" series={[
              { key: 'blocked', label: 'Blocked', color: ACTION_COLORS.BLOCK },
              { key: 'warned', label: 'Warned', color: ACTION_COLORS.WARN },
              { key: 'redacted', label: 'Redacted', color: ACTION_COLORS.REDACT },
              { key: 'other', label: 'Allowed / monitored', color: ACTION_COLORS.MONITOR },
            ]} />
          ) : <Empty text={a ? 'No prompt checks in this period.' : 'Loading...'} />}
        </Panel>
        <Panel title="Accounts by plan" hint="Right now">
          {planSlices.length ? <DonutChart slices={planSlices} centerLabel="accounts" /> : <Empty />}
        </Panel>
        <Panel title="Account types">
          {typeSlices.length ? <DonutChart slices={typeSlices} centerLabel="accounts" /> : <Empty />}
        </Panel>
        <Panel title="Protection outcomes" hint={`Security events, last ${days} days`}>
          {actionSlices.length ? <DonutChart slices={actionSlices} centerLabel="events" /> : <Empty text="No security events in this period." />}
        </Panel>
        <Panel title="What was detected" hint={`Last ${days} days`}>
          {categorySlices.length ? <DonutChart pie slices={categorySlices} /> : <Empty text="No security events in this period." />}
        </Panel>
        <Panel title="Top accounts by prompt checks" hint="This month">
          {a && a.top_accounts_this_month.length
            ? <BarList rows={a.top_accounts_this_month.map((t) => ({ label: t.name, value: t.prompt_checks }))} />
            : <Empty text="No prompt checks this month." />}
        </Panel>
        <Panel title="Active browsers" hint="By browser">
          {browserSlices.length ? <DonutChart slices={browserSlices} centerLabel="browsers" /> : <Empty text="No active browsers." />}
        </Panel>
        <Panel title="Operating systems" hint="Active browsers">
          {a && Object.keys(a.platforms).length ? <BarList rows={rows(a.platforms)} color={SERIES[2]} /> : <Empty text="No active browsers." />}
        </Panel>
        <Panel title="Users by role">
          {a && Object.keys(a.users_by_role).length ? <BarList rows={rows(a.users_by_role, ROLE_LABELS)} color={SERIES[6]} /> : <Empty />}
        </Panel>
      </div>

      <div className="card-title" style={{ marginTop: 6 }}>All figures</div>
      <div className="grid-kpi">
        {tiles.map((t) => (
          <div key={t.label} className="card kpi">
            <div className="kpi-label">{t.label}</div>
            <div className="kpi-value">{t.value}</div>
            <div className="kpi-def">{t.def}</div>
          </div>
        ))}
      </div>

      {can('jobs.run') && (
        <section className="card card-pad">
          <div className="card-head">
            <div>
              <div className="card-title">Reminder job</div>
              <p className="card-note">Sends licence reminders 7, 3 and 1 days before expiry and on expiry. Runs hourly; each reminder is sent once. Access is enforced on every request, not by this job.</p>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => openDialog({
              title: 'Run the reminder job now?', confirmLabel: 'Run now',
              onConfirm: async () => { const r = await api.runReminders(); setNotice(`Reminder job finished: ${r.created} new reminder(s).`); load(); },
            })}><RefreshCw size={14} /> Run now</button>
          </div>
        </section>
      )}
    </div>
  );
};
