import React, { useEffect, useState } from 'react';
import { Download, RefreshCw, ScrollText } from 'lucide-react';
import { api } from '../services/api';
import { AuditLogEntry } from '../types';

const FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All activity' },
  { value: 'policy', label: 'Policy changes' },
  { value: 'domain', label: 'Website rules' },
  { value: 'keyword', label: 'Keywords' },
  { value: 'settings', label: 'Settings' },
  { value: 'device', label: 'Browser activations' },
  { value: 'user', label: 'Accounts & invites' },
  { value: 'employee', label: 'Employee actions' },
  { value: 'login', label: 'Sign-ins' },
  { value: 'events.export', label: 'Exports' },
];

const PAGE_SIZE = 50;

function toCsv(rows: AuditLogEntry[]): string {
  const cols: Array<keyof AuditLogEntry> = ['occurred_at', 'actor', 'action', 'target_type', 'target_id', 'summary', 'ip_address', 'details'];
  const safe = (v: unknown) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection guard
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => safe(r[c])).join(','))].join('\r\n');
}

export const AuditLog: React.FC = () => {
  const [items, setItems] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const res = await api.getAuditLog(page, PAGE_SIZE, filter || undefined);
      setItems(res.items);
      setTotal(res.total);
      setError('');
    } catch (e: any) {
      setError(e.message || 'Could not load the audit log');
    }
  };

  useEffect(() => {
    load();
  }, [page, filter]);

  const exportCsv = async () => {
    const all: AuditLogEntry[] = [];
    for (let p = 1; p <= Math.ceil(total / 500) && p <= 20; p++) {
      const res = await api.getAuditLog(p, 500, filter || undefined);
      all.push(...res.items);
    }
    const blob = new Blob([toCsv(all)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agentshield-admin-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const pretty = (details?: string) => {
    if (!details) return '';
    try {
      return JSON.stringify(JSON.parse(details), null, 2);
    } catch {
      return details;
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ScrollText size={22} color="var(--color-primary)" /> Admin Audit Log
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', maxWidth: '760px' }}>
            Every change made in this dashboard and every sign-in attempt, with before/after values. Entries cannot be edited or
            deleted from the dashboard.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <select value={filter} onChange={(e) => { setFilter(e.target.value); setPage(1); }} style={{ padding: '7px 10px', border: '1px solid var(--border-default)', borderRadius: '8px', fontSize: '13px' }}>
            {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          <button className="btn-secondary" onClick={load}><RefreshCw size={14} /> Refresh</button>
          <button className="btn-secondary" onClick={exportCsv} disabled={total === 0}><Download size={14} /> Export CSV</button>
        </div>
      </div>

      {error && <div style={{ color: 'var(--color-danger-text)', fontSize: '13px' }}>{error}</div>}

      <div className="glass-panel" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
          <thead>
            <tr style={{ background: 'var(--bg-subtle)', color: 'var(--text-muted)', fontSize: '12px' }}>
              <th style={{ padding: '10px 16px' }}>When</th>
              <th style={{ padding: '10px 16px' }}>Who</th>
              <th style={{ padding: '10px 16px' }}>Action</th>
              <th style={{ padding: '10px 16px' }}>What changed</th>
              <th style={{ padding: '10px 16px' }}>IP address</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => {
              const failed = a.action.startsWith('login.failed') || a.action.startsWith('login.locked');
              return (
                <React.Fragment key={a.id}>
                  <tr
                    style={{ borderTop: '1px solid var(--border-subtle)', cursor: a.details ? 'pointer' : 'default' }}
                    onClick={() => a.details && setExpanded(expanded === a.id ? null : a.id)}
                  >
                    <td style={{ padding: '10px 16px', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{new Date(a.occurred_at).toLocaleString()}</td>
                    <td style={{ padding: '10px 16px', fontWeight: 600 }}>{a.actor || '—'}</td>
                    <td style={{ padding: '10px 16px' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: failed ? 'var(--color-danger-text)' : 'var(--color-primary)' }}>{a.action}</span>
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      {a.summary}
                      {a.details && <span style={{ color: 'var(--text-faint)', fontSize: '11px' }}> {expanded === a.id ? '▲' : '▼ details'}</span>}
                    </td>
                    <td style={{ padding: '10px 16px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{a.ip_address || '—'}</td>
                  </tr>
                  {expanded === a.id && (
                    <tr>
                      <td colSpan={5} style={{ padding: '0 16px 12px' }}>
                        <pre style={{ margin: 0, padding: '10px', background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)', borderRadius: '6px', fontSize: '12px', whiteSpace: 'pre-wrap' }}>
                          {pretty(a.details)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {items.length === 0 && (
              <tr><td colSpan={5} style={{ padding: '16px', color: 'var(--text-muted)' }}>No activity recorded yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {total > PAGE_SIZE && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '10px', fontSize: '13px' }}>
          <button className="btn-secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span style={{ color: 'var(--text-muted)' }}>Page {page} of {Math.ceil(total / PAGE_SIZE)}</span>
          <button className="btn-secondary" disabled={page * PAGE_SIZE >= total} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
};
