import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api';
import { formatDateTime } from '../format';
import { Alert, PageHead, Pill } from '../ui';
import type { Health as HealthData } from '../types';

const LABELS: Record<string, string> = {
  customer_sign_in_failures: 'Customer sign-in failures',
  staff_sign_in_failures: 'Staff sign-in failures',
  activation_failures: 'Browser activation failures',
  device_sign_in_refusals: 'Browser sign-ins refused (bad signature)',
  webhooks_failed: 'Payment webhooks failed',
  webhooks_received: 'Payment webhooks received',
  security_events: 'Security events (all accounts)',
  blocked_prompts: 'Prompts blocked',
};

/** Operational signals for the last 24 hours. Counts only; no customer content. */
export const Health: React.FC = () => {
  const [h, setH] = useState<HealthData | null>(null);
  const [error, setError] = useState('');
  const load = () => api.health().then(setH).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  return (
    <div className="stack">
      <PageHead title="Platform health" sub="Last 24 hours, from server records. Request latency and error-rate monitoring arrive in a later phase."
        right={<button type="button" className="btn btn-sm" onClick={load}><RefreshCw size={14} /> Refresh</button>} />
      <Alert kind="error">{error}</Alert>
      {h && (
        <>
          <div className="grid-kpi">
            <div className="card kpi">
              <div className="kpi-label">Database</div>
              <div className="kpi-value" style={{ fontSize: 20 }}>{h.database.ok ? <Pill tone="ok">reachable</Pill> : <Pill tone="bad">down</Pill>}</div>
              <div className="kpi-def">Round trip {h.database.latency_ms} ms · checked {formatDateTime(h.server_time)}</div>
            </div>
            {Object.entries(h.last_24h).map(([k, v]) => (
              <div key={k} className="card kpi">
                <div className="kpi-label">{LABELS[k] || k}</div>
                <div className="kpi-value">{v.toLocaleString()}</div>
              </div>
            ))}
          </div>
          <section className="card card-pad">
            <div className="card-head">
              <div className="card-title">Extension versions in use</div>
              <span className="card-note">Current release: <strong>{h.current_release || '—'}</strong> · browsers that checked in during the last 7 days</span>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Version</th><th>Browsers</th><th /></tr></thead>
                <tbody>
                  {Object.keys(h.extension_versions).length === 0 && <tr><td colSpan={3} className="empty">No browsers checked in recently.</td></tr>}
                  {Object.entries(h.extension_versions).sort((a, b) => b[1] - a[1]).map(([v, n]) => (
                    <tr key={v}>
                      <td className="cell-main">{v}</td>
                      <td>{n}</td>
                      <td>{h.current_release && v !== h.current_release ? <Pill tone="warn">outdated</Pill> : <Pill tone="ok">current</Pill>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
};
