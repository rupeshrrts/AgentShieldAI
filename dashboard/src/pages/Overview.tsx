import React, { useEffect, useState } from 'react';
import { motion, Variants } from 'framer-motion';
import { AlertTriangle, Circle, Clock, Eye, FileCode, Monitor, ShieldAlert, ShieldCheck } from 'lucide-react';
import { EndpointSummary, Me, MetricsSummary } from '../types';
import { api } from '../services/api';
import { NavTab } from '../components/Sidebar';
import { actionBadgeClass } from './SecurityEvents';
import { ACTION_COLORS, BarList, DonutChart, SERIES, SEVERITY_COLORS, Slice, StackedColumns } from '../components/Charts';

// Fixed order, so each category keeps its colour whatever its rank
const CATEGORY_ORDER = ['SECRET', 'PII', 'RESTRICTED', 'FILE', 'UNAUTHORIZED_TOOL', 'WEB_FILTER', 'PROMPT_LOG'];
const CATEGORY_LABELS: Record<string, string> = {
  SECRET: 'Credentials & keys',
  PII: 'Personal data',
  RESTRICTED: 'Confidential keywords',
  FILE: 'File uploads',
  UNAUTHORIZED_TOOL: 'Blocked websites',
  WEB_FILTER: 'Blocked website categories',
  PROMPT_LOG: 'Clean prompts',
};

const ChartPanel: React.FC<{ title: string; hint?: string; children: React.ReactNode }> = ({ title, hint, children }) => (
  <div className="glass-panel" style={{ padding: '20px' }}>
    <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-main)', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
      <span>{title}</span>
      {hint && <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>{hint}</span>}
    </div>
    {children}
  </div>
);

const Empty: React.FC<{ text?: string }> = ({ text = 'No events recorded yet.' }) => (
  <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>{text}</div>
);

interface OverviewProps {
  metrics: MetricsSummary | null;
  endpoints: EndpointSummary | null;
  me: Me | null;
  isAdmin: boolean;
  onNavigate: (tab: NavTab) => void;
}

interface ChecklistItem {
  done: boolean;
  title: string;
  detail: string;
  tab: NavTab;
  cta: string;
}

const card: React.CSSProperties = { padding: '20px' };

const list: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };
const item: Variants = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: 'easeOut' } } };

export const Overview: React.FC<OverviewProps> = ({ metrics, endpoints, me, isAdmin, onNavigate }) => {
  const [keyCount, setKeyCount] = useState<number | null>(null);
  const [policyReviewed, setPolicyReviewed] = useState<boolean | null>(null);

  // Facts for the setup checklist, all read from the backend
  useEffect(() => {
    if (!isAdmin) return;
    api
      .getUsers()
      .then((u) => setKeyCount(u.users.filter((x) => x.role !== 'ADMIN').length + u.pending_invites.length))
      .catch(() => setKeyCount(null));
    api.getAuditLog(1, 1, 'policy').then((r) => setPolicyReviewed(r.total > 0)).catch(() => setPolicyReviewed(null));
  }, [isAdmin]);

  if (!metrics) {
    return <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading security overview...</div>;
  }

  const checklist: ChecklistItem[] = [
    {
      done: me ? !me.using_default_password : false,
      title: 'Change the default admin password',
      detail: 'The default password is published in the documentation.',
      tab: 'deployment',
      cta: 'Change password',
    },
    {
      done: (keyCount ?? 0) > 0,
      title: 'Invite your team',
      detail: 'Each person gets an email to create an account, then activates their own browser.',
      tab: 'users',
      cta: 'Invite people',
    },
    {
      done: (endpoints?.total ?? 0) > 0,
      title: 'Connect the first browser',
      detail: 'Install the extension, sign in to it and enter an activation code from My activation.',
      tab: 'endpoints',
      cta: 'View browsers',
    },
    {
      done: Boolean(policyReviewed),
      title: 'Review your policies',
      detail: 'Pick a preset (Recommended, Strict or Monitor only) or adjust rules.',
      tab: 'policies',
      cta: 'Open policies',
    },
    {
      done: metrics.blocked_count > 0,
      title: 'Test that blocking works',
      detail: 'Paste a test API key into an AI site and confirm it is blocked.',
      tab: 'events',
      cta: 'See events',
    },
  ];
  const remaining = checklist.filter((c) => !c.done).length;

  const online = endpoints?.online ?? 0;
  const total = endpoints?.total ?? 0;
  const protectionState =
    total === 0
      ? { tone: 'warning', title: 'No browsers connected yet', text: 'Nothing is protected until the extension is installed and enrolled.' }
      : online === 0
      ? { tone: 'danger', title: 'No browsers checked in recently', text: `${total} enrolled browser(s), none seen in the last 15 minutes.` }
      : {
          tone: 'success',
          title: `${online} of ${total} browsers online`,
          text:
            (endpoints?.outdated_policy ?? 0) > 0
              ? `${endpoints?.outdated_policy} browser(s) have not picked up the latest policy yet (they sync every 5 minutes).`
              : 'All online browsers have the latest policy.',
        };
  const toneColor = protectionState.tone === 'success' ? 'var(--color-success)' : protectionState.tone === 'danger' ? 'var(--color-danger)' : 'var(--color-warning)';

  const statCards = [
    { title: 'Events (last 24 h)', value: metrics.events_last_24h ?? 0, icon: <Clock size={20} color="var(--color-primary)" />, sub: 'Prompts, uploads and site visits checked' },
    { title: 'Blocked', value: metrics.blocked_count, icon: <ShieldAlert size={20} color="var(--color-danger)" />, sub: 'Prompts, files and sites stopped' },
    { title: 'Warned', value: metrics.warned_count, icon: <AlertTriangle size={20} color="var(--color-warning)" />, sub: 'Employee had to confirm' },
    { title: 'Redacted', value: metrics.redacted_count, icon: <FileCode size={20} color="var(--color-primary)" />, sub: 'Sensitive terms masked before sending' },
    { title: 'Monitored', value: metrics.monitored_count ?? 0, icon: <Eye size={20} color="#6d28d9" />, sub: 'Allowed but recorded for review' },
  ];

  // Chart data: every value comes from /api/v1/metrics/summary
  const actionSlices: Slice[] = [
    { label: 'Blocked', value: metrics.blocked_count, color: ACTION_COLORS.BLOCK },
    { label: 'Warned', value: metrics.warned_count, color: ACTION_COLORS.WARN },
    { label: 'Redacted', value: metrics.redacted_count, color: ACTION_COLORS.REDACT },
    { label: 'Monitored', value: metrics.monitored_count ?? 0, color: ACTION_COLORS.MONITOR },
    { label: 'Allowed', value: metrics.allowed_count, color: ACTION_COLORS.ALLOW },
  ].filter((s) => s.value > 0);
  const categories = metrics.category_distribution || {};
  const categorySlices: Slice[] = [
    ...CATEGORY_ORDER.map((cat, i) => ({ label: CATEGORY_LABELS[cat], value: categories[cat] || 0, color: SERIES[i] })),
    // Anything not in the fixed list folds into "Other" (never a generated colour)
    {
      label: 'Other',
      value: Object.entries(categories).filter(([c]) => !CATEGORY_ORDER.includes(c)).reduce((a, [, n]) => a + n, 0),
      color: SERIES[7],
    },
  ].filter((s) => s.value > 0);
  const severities = metrics.severity_distribution || {};
  const severitySlices: Slice[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
    .map((sev) => ({ label: sev.charAt(0) + sev.slice(1).toLowerCase(), value: severities[sev] || 0, color: SEVERITY_COLORS[sev] }))
    .filter((s) => s.value > 0);
  const siteRows = Object.entries(metrics.site_distribution || {}).map(([label, value]) => ({ label, value }));
  const pct = (n: number) => `${Math.round((n / (metrics.total_events || 1)) * 1000) / 10}%`;
  const stopped = metrics.blocked_count + metrics.redacted_count;
  const rateCards = [
    { title: 'Total events', value: metrics.total_events.toLocaleString(), sub: 'Everything recorded for this account' },
    { title: 'Block rate', value: pct(metrics.blocked_count), sub: 'Share of events that were blocked' },
    { title: 'Data stopped or masked', value: pct(stopped), sub: 'Blocked + redacted, of all events' },
    { title: 'Browsers online', value: `${online} / ${total}`, sub: 'Checked in within 15 minutes' },
  ];

  return (
    <motion.div variants={list} initial="hidden" animate="show" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Protection status from real endpoint heartbeats */}
      <motion.div variants={item} className="glass-panel" style={{ ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
          <div className="icon-tile" style={{ color: toneColor, background: `color-mix(in srgb, ${toneColor} 10%, white)` }}>
            <Monitor size={20} />
          </div>
          <div>
            <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-main)' }}>{protectionState.title}</h2>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{protectionState.text}</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="btn-secondary" onClick={() => onNavigate('endpoints')}>View browsers</button>
          <button className="btn-primary" onClick={() => onNavigate('policies')}>Policies</button>
        </div>
      </motion.div>

      {/* Getting started: only the steps still open */}
      {isAdmin && remaining > 0 && (
        <motion.div variants={item} className="glass-panel" style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-main)' }}>Finish setup</h3>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>{checklist.length - remaining} of {checklist.length} complete</span>
          </div>
          <div className="progress" style={{ marginBottom: '14px' }}>
            <motion.div
              className="progress-fill"
              initial={{ width: 0 }}
              animate={{ width: `${((checklist.length - remaining) / checklist.length) * 100}%` }}
              transition={{ duration: 0.6, ease: 'easeOut' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {checklist.filter((c) => !c.done).map((c) => (
              <div key={c.title} className="list-row">
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <Circle size={16} color="var(--text-faint)" />
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-main)' }}>{c.title}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{c.detail}</div>
                  </div>
                </div>
                <button className="btn-secondary" style={{ padding: '5px 12px', fontSize: '12px' }} onClick={() => onNavigate(c.tab)}>
                  {c.cta}
                </button>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* KPI cards (all-time counts except the first) */}
      <motion.div variants={list} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px' }}>
        {statCards.map((c) => (
          <motion.div key={c.title} variants={item} whileHover={{ y: -2 }} className="glass-panel" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text-muted)' }}>{c.title}</span>
              <span className="icon-tile icon-tile-sm">{c.icon}</span>
            </div>
            <div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--text-main)', lineHeight: 1, letterSpacing: '-0.5px' }}>{c.value}</div>
            <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>{c.sub}</div>
          </motion.div>
        ))}
      </motion.div>

      {/* Rates derived from the same API counts */}
      {metrics.total_events > 0 && (
        <motion.div variants={list} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px' }}>
          {rateCards.map((c) => (
            <motion.div key={c.title} variants={item} className="glass-panel" style={{ padding: '16px 18px' }}>
              <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text-muted)' }}>{c.title}</div>
              <div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--text-main)', lineHeight: 1.2, letterSpacing: '-0.5px', marginTop: '6px' }}>{c.value}</div>
              <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '4px' }}>{c.sub}</div>
            </motion.div>
          ))}
        </motion.div>
      )}

      {/* Charts: two per row on wide screens, one per row on narrow ones */}
      <motion.div variants={item} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 400px), 1fr))', gap: '20px' }}>
        <ChartPanel title="Actions taken" hint="All events">
          {actionSlices.length ? <DonutChart slices={actionSlices} centerLabel="events" /> : <Empty />}
        </ChartPanel>
        <ChartPanel title="What was detected" hint={`${metrics.active_policies_count} rules enabled`}>
          {categorySlices.length ? <DonutChart pie slices={categorySlices} /> : <Empty />}
        </ChartPanel>
        <ChartPanel title="Events by severity">
          {severitySlices.length ? <DonutChart slices={severitySlices} centerLabel="events" /> : <Empty />}
        </ChartPanel>
        <ChartPanel title="Events by site" hint="Top 8">
          {siteRows.length ? <BarList rows={siteRows} /> : <Empty />}
        </ChartPanel>
      </motion.div>

      <motion.div variants={item} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '20px' }}>
        <ChartPanel title="Events per day" hint="Last 14 days (UTC)">
          {(metrics.daily_events || []).some((d) => d.blocked + d.warned + d.redacted + d.other > 0) ? (
            <StackedColumns
              rows={metrics.daily_events || []}
              xKey="day"
              series={[
                { key: 'blocked', label: 'Blocked', color: ACTION_COLORS.BLOCK },
                { key: 'warned', label: 'Warned', color: ACTION_COLORS.WARN },
                { key: 'redacted', label: 'Redacted', color: ACTION_COLORS.REDACT },
                { key: 'other', label: 'Monitored / allowed', color: ACTION_COLORS.MONITOR },
              ]}
            />
          ) : (
            <Empty text="No events in the last 14 days." />
          )}
        </ChartPanel>

        {/* Recent events */}
        <div className="glass-panel" style={card}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-main)', marginBottom: '16px', display: 'flex', justifyContent: 'space-between' }}>
            <span>Recent activity</span>
            <button onClick={() => onNavigate('events')} style={{ background: 'none', border: 'none', color: 'var(--color-primary)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
              View all →
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {metrics.recent_events && metrics.recent_events.length > 0 ? (
              metrics.recent_events.slice(0, 6).map((evt) => (
                <div key={evt.id} className="list-row" style={{ gap: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                    <span className={actionBadgeClass(evt.action)} style={{ fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '4px' }}>{evt.action}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-main)' }}>{evt.rule_id}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {evt.user_id || 'unknown'} • {evt.site}
                      </div>
                    </div>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {new Date(evt.occurred_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              ))
            ) : (
              <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No events recorded yet.</div>
            )}
          </div>
        </div>
      </motion.div>

      {total > 0 && online === total && remaining === 0 && (
        <motion.div variants={item} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: 'var(--color-success-text)' }}>
          <ShieldCheck size={16} /> Setup complete. Every enrolled browser checked in within the last 15 minutes.
        </motion.div>
      )}
    </motion.div>
  );
};
