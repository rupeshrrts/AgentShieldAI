import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { formatDateTime } from '../format';
import { Alert, PageHead, Pill } from '../ui';
import type { AuditRow } from '../types';

const ACTIONS = [
  ['', 'All events'], ['staff', 'Staff sign-ins & management'], ['platform', 'Platform actions'], ['billing', 'Payments'],
  ['trial', 'Trials'], ['device', 'Browser activations'], ['user', 'Customer accounts'], ['login', 'Customer sign-ins'],
];

/** Platform-wide audit log (latest 200 matching entries). */
export const Audit: React.FC = () => {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [action, setAction] = useState('');
  const [actorType, setActorType] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api.audit({ action: action || undefined, actor_type: actorType || undefined }).then(setRows).catch((e) => setError(e.message));
  }, [action, actorType]);

  return (
    <div className="stack">
      <PageHead title="Audit log" sub="Every administrative change and sign-in, by customers, AgentShieldAI staff and the system." />
      <Alert kind="error">{error}</Alert>
      <section className="card">
        <div className="card-pad row">
          <select className="select" style={{ width: 240 }} value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action">
            {ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select className="select" style={{ width: 180 }} value={actorType} onChange={(e) => setActorType(e.target.value)} aria-label="Filter by actor type">
            <option value="">Any actor</option>
            <option value="staff">AgentShieldAI staff</option>
            <option value="customer">Customers</option>
            <option value="system">System</option>
          </select>
          <span className="card-note">Latest {rows.length} entries</span>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>When</th><th>Actor</th><th>Company</th><th>What</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={4} className="empty">No entries.</td></tr>}
              {rows.map((a, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(a.occurred_at)}</td>
                  <td><Pill tone={a.actor_type === 'staff' ? 'info' : a.actor_type === 'system' ? 'muted' : 'ok'}>{a.actor_type}</Pill><div className="cell-sub">{a.actor}</div><div className="cell-sub">{a.ip_address}</div></td>
                  <td>{a.organization || '—'}</td>
                  <td><span className="tag">{a.action}</span><div className="cell-sub">{a.summary}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
