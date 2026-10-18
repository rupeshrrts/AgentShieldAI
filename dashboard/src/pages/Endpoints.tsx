import React, { useState } from 'react';
import { Monitor, RefreshCw, Search } from 'lucide-react';
import { EndpointSummary } from '../types';
import { NavTab } from '../components/Sidebar';

interface EndpointsProps {
  endpoints: EndpointSummary | null;
  onRefresh: () => void;
  onNavigate: (tab: NavTab) => void;
}

const SOURCE_LABELS: Record<string, string> = {
  managed_policy: 'IT policy',
  installer: 'Installer',
  enrollment_code: 'Enrollment code (retired)',
  activation: 'Account activation',
  none: 'Not enrolled',
};

const STATUS_STYLE: Record<string, { label: string; bg: string; fg: string; border: string }> = {
  ONLINE: { label: 'Online', bg: 'var(--color-success-bg)', fg: 'var(--color-success-text)', border: 'var(--color-success-border)' },
  STALE: { label: 'Not seen today', bg: 'var(--color-warning-bg)', fg: 'var(--color-warning-text)', border: 'var(--color-warning-border)' },
  OFFLINE: { label: 'Offline', bg: 'var(--bg-subtle)', fg: 'var(--text-muted)', border: 'var(--border-default)' },
};

const ago = (iso?: string) => {
  if (!iso) return '—';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
};

export const Endpoints: React.FC<EndpointsProps> = ({ endpoints, onRefresh, onNavigate }) => {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'ALL' | 'ONLINE' | 'STALE' | 'OFFLINE'>('ALL');

  const items = (endpoints?.items || []).filter((e) => {
    if (status !== 'ALL' && e.status !== status) return false;
    const q = search.trim().toLowerCase();
    return !q || (e.user_id || '').toLowerCase().includes(q) || (e.browser || '').toLowerCase().includes(q);
  });
  const employees = new Set((endpoints?.items || []).map((e) => e.user_id).filter(Boolean)).size;

  const stats = [
    { label: 'Enrolled browsers', value: endpoints?.total ?? 0 },
    { label: 'Employees', value: employees },
    { label: 'Online now', value: endpoints?.online ?? 0, color: 'var(--color-success-text)' },
    { label: 'Not seen today', value: (endpoints?.stale ?? 0) + (endpoints?.offline ?? 0), color: 'var(--color-warning-text)' },
    { label: 'Outdated policy', value: endpoints?.outdated_policy ?? 0, color: 'var(--color-danger-text)' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Monitor size={22} color="var(--color-primary)" /> Protected Browsers
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', maxWidth: '760px' }}>
            Every browser with the AgentShield extension reports in about every 5 minutes. A browser that stops reporting may have
            been closed, uninstalled, or had the extension disabled. Latest policy version: v{endpoints?.current_policy_version ?? 1}.
          </p>
        </div>
        <button className="btn-secondary" onClick={onRefresh}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' }}>
        {stats.map((s) => (
          <div key={s.label} className="glass-panel" style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)' }}>{s.label}</div>
            <div style={{ fontSize: '26px', fontWeight: 800, color: s.color || 'var(--text-main)' }}>{s.value}</div>
          </div>
        ))}
      </div>

      {(endpoints?.total ?? 0) === 0 ? (
        <div className="glass-panel" style={{ padding: '28px', textAlign: 'center' }}>
          <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-main)' }}>No browsers have connected yet.</p>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: '6px 0 14px' }}>
            Invite people, install the extension, and have each person activate it with their account and an activation code. The browser appears here within a minute.
          </p>
          <button className="btn-primary" onClick={() => onNavigate('users')}>Invite people</button>
        </div>
      ) : (
        <div className="glass-panel" style={{ overflowX: 'auto' }}>
          <div style={{ display: 'flex', gap: '10px', padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: '1 1 240px' }}>
              <Search size={14} color="var(--text-muted)" style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search employee or browser"
                style={{ width: '100%', padding: '7px 10px 7px 30px', border: '1px solid var(--border-default)', borderRadius: '8px', fontSize: '13px' }}
              />
            </div>
            <select value={status} onChange={(e) => setStatus(e.target.value as any)} style={{ padding: '7px 10px', border: '1px solid var(--border-default)', borderRadius: '8px', fontSize: '13px' }}>
              <option value="ALL">All statuses</option>
              <option value="ONLINE">Online</option>
              <option value="STALE">Not seen today</option>
              <option value="OFFLINE">Offline</option>
            </select>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
            <thead>
              <tr style={{ background: 'var(--bg-subtle)', color: 'var(--text-muted)', fontSize: '12px' }}>
                <th style={{ padding: '10px 16px' }}>Employee</th>
                <th style={{ padding: '10px 16px' }}>Status</th>
                <th style={{ padding: '10px 16px' }}>Last seen</th>
                <th style={{ padding: '10px 16px' }}>Browser</th>
                <th style={{ padding: '10px 16px' }}>Extension</th>
                <th style={{ padding: '10px 16px' }}>Policy</th>
                <th style={{ padding: '10px 16px' }}>Enrolled via</th>
                <th style={{ padding: '10px 16px' }}>First seen</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => {
                const st = STATUS_STYLE[e.status];
                return (
                  <tr key={e.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '10px 16px', fontWeight: 600, color: 'var(--text-main)' }}>{e.user_id || '—'}</td>
                    <td style={{ padding: '10px 16px' }}>
                      <span style={{ fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '9999px', background: st.bg, color: st.fg, border: `1px solid ${st.border}` }}>
                        {st.label}
                      </span>
                    </td>
                    <td style={{ padding: '10px 16px', color: 'var(--text-muted)' }} title={e.last_seen_at ? new Date(e.last_seen_at).toLocaleString() : ''}>{ago(e.last_seen_at)}</td>
                    <td style={{ padding: '10px 16px' }}>{e.browser || '—'}{e.platform ? ` • ${e.platform}` : ''}</td>
                    <td style={{ padding: '10px 16px', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{e.extension_version ? `v${e.extension_version}` : '—'}</td>
                    <td style={{ padding: '10px 16px', color: e.policy_current ? 'var(--color-success-text)' : 'var(--color-danger-text)', fontWeight: 600 }}>
                      v{e.policy_version ?? '?'} {e.policy_current ? '' : '(outdated)'}
                    </td>
                    <td style={{ padding: '10px 16px', color: 'var(--text-muted)' }}>{SOURCE_LABELS[e.enrollment_source || 'none'] || e.enrollment_source}</td>
                    <td style={{ padding: '10px 16px', color: 'var(--text-muted)' }}>{e.first_seen_at ? new Date(e.first_seen_at).toLocaleDateString() : '—'}</td>
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ padding: '16px', color: 'var(--text-muted)' }}>No browsers match these filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
