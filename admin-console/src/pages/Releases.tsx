import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { formatDate } from '../format';
import { Alert, PageHead, Pill } from '../ui';
import type { Release } from '../types';

/** Extension versions shown on the customers' download page. */
export const Releases: React.FC<{ can: (p: string) => boolean }> = ({ can }) => {
  const [rows, setRows] = useState<Release[]>([]);
  const [form, setForm] = useState({ version: '', notes: '', sha256: '', min_chrome: '110', min_edge: '110' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = () => api.releases().then(setRows).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const publish = async (r: Partial<Release> & { version: string }) => {
    setError('');
    try {
      await api.publishRelease({ ...r, sha256: r.sha256 || undefined, make_current: true });
      setNotice(`Version ${r.version} is now current.`);
      setForm({ version: '', notes: '', sha256: '', min_chrome: '110', min_edge: '110' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not publish.');
    }
  };

  return (
    <div className="stack">
      <PageHead title="Extension releases" sub="Build the package with scripts/packaging/pack-extension.js; the current build registers itself when the server starts." />
      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{notice}</Alert>
      {can('releases.manage') && (
        <section className="card card-pad stack" style={{ gap: 12 }}>
          <div className="card-title">Publish a release</div>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="label" style={{ width: 140 }}>Version<input className="input" placeholder="1.5.0" value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} /></label>
            <label className="label" style={{ flex: '1 1 320px' }}>SHA-256 of the .zip (optional)<input className="input mono" value={form.sha256} onChange={(e) => setForm({ ...form, sha256: e.target.value.trim().toLowerCase() })} /></label>
            <label className="label" style={{ width: 110 }}>Min Chrome<input className="input" value={form.min_chrome} onChange={(e) => setForm({ ...form, min_chrome: e.target.value })} /></label>
            <label className="label" style={{ width: 110 }}>Min Edge<input className="input" value={form.min_edge} onChange={(e) => setForm({ ...form, min_edge: e.target.value })} /></label>
          </div>
          <label className="label">Release notes<textarea className="input" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
          <div><button type="button" className="btn btn-primary" disabled={!form.version} onClick={() => publish(form)}>Publish as current</button></div>
        </section>
      )}
      <section className="card">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Version</th><th>Published</th><th>Browsers</th><th>SHA-256</th><th /></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} className="empty">No releases registered yet.</td></tr>}
              {rows.map((r) => (
                <tr key={r.version}>
                  <td className="cell-main">{r.version} {r.is_current && <Pill tone="ok">current</Pill>}</td>
                  <td>{formatDate(r.published_at)}</td>
                  <td>Chrome {r.min_chrome}+ · Edge {r.min_edge}+</td>
                  <td><span className="tag">{r.sha256 ? `${r.sha256.slice(0, 16)}…` : '—'}</span></td>
                  <td style={{ textAlign: 'right' }}>{can('releases.manage') && !r.is_current && <button type="button" className="btn-link" onClick={() => publish({ ...r, notes: r.notes || undefined })}>Make current</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
