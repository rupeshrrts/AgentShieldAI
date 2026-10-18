import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, Copy, KeyRound, Plug } from 'lucide-react';
import { SectionHeader } from '../components/SectionHeader';
import { api } from '../services/api';
import { ApiTokenRow } from '../types';
import { formatDate, formatDateTime } from '../utils/format';

/**
 * Personal API tokens ("API connections"): read-only access to your own alerts and usage for scripts
 * or a SIEM. The token is shown once; only a hash is stored on the server.
 */
export const ApiTokens: React.FC = () => {
  const [tokens, setTokens] = useState<ApiTokenRow[]>([]);
  const [scopes, setScopes] = useState<{ scope: string; label: string }[]>([]);
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string[]>(['alerts:read']);
  const [expiry, setExpiry] = useState('90');
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.getApiTokens().then((r) => { setTokens(r.tokens); setScopes(r.scopes); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const t = await api.createApiToken(name.trim(), chosen, expiry === 'never' ? null : Number(expiry));
      setCreated(t.token);
      setCopied(false);
      setName('');
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const revoke = async (t: ApiTokenRow) => {
    if (!window.confirm(`Revoke "${t.name}"? Anything using it stops working immediately.`)) return;
    try {
      await api.revokeApiToken(t.id);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const base = api.apiBase();

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 className="page-title">API connections</h1>
        <p className="page-subtitle">Read your own security alerts and usage from scripts or a SIEM. Tokens are read-only and limited to your account.</p>
      </div>
      {error && <div className="callout callout-error">{error}</div>}

      {created && (
        <div className="callout callout-success" style={{ display: 'block' }}>
          <strong>Copy your new token now.</strong> For your security it is shown only once.
          <div className="token-box">
            <code>{created}</code>
            <button type="button" className="btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(created); setCopied(true); }}>
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      <section className="glass-panel" style={{ padding: 24 }}>
        <SectionHeader icon={<KeyRound size={18} />} title="Create a token" />
        <form onSubmit={create} className="form-grid">
          <label className="field-label">Name
            <input className="input" required minLength={2} maxLength={80} placeholder="e.g. Splunk" value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} />
          </label>
          <label className="field-label">Expires
            <select className="input" value={expiry} onChange={(e) => setExpiry(e.target.value)} style={{ width: '100%' }}>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In 1 year</option>
              <option value="never">Never</option>
            </select>
          </label>
          <fieldset className="field-label" style={{ border: 'none', padding: 0 }}>
            <legend style={{ marginBottom: 6 }}>Access</legend>
            {scopes.map((s) => (
              <label key={s.scope} className="check-row">
                <input type="checkbox" checked={chosen.includes(s.scope)}
                  onChange={(e) => setChosen(e.target.checked ? [...chosen, s.scope] : chosen.filter((x) => x !== s.scope))} />
                {s.label} <code className="mono-pill">{s.scope}</code>
              </label>
            ))}
          </fieldset>
          <div><button className="btn-primary" type="submit" disabled={!name.trim() || chosen.length === 0}>Create token</button></div>
        </form>
      </section>

      <section className="glass-panel" style={{ padding: 24 }}>
        <SectionHeader icon={<Plug size={18} />} title="Your tokens" />
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Name</th><th>Access</th><th>Status</th><th>Last used</th><th /></tr></thead>
            <tbody>
              {tokens.length === 0 && <tr><td colSpan={5} className="empty-cell">No tokens yet.</td></tr>}
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td><strong>{t.name}</strong><div className="cell-sub"><code>{t.prefix}…</code> · created {formatDate(t.created_at)}</div></td>
                  <td>{t.scopes.join(', ')}</td>
                  <td>
                    <span className={`status-pill ${t.state === 'active' ? 'status-active' : 'status-expired'}`}><span className="status-dot" /> {t.state}</span>
                    <div className="cell-sub">{t.expires_at ? `${t.state === 'expired' ? 'Expired' : 'Expires'} ${formatDate(t.expires_at)}` : 'No expiry'}</div>
                  </td>
                  <td>{t.last_used_at ? formatDateTime(t.last_used_at) : 'Never'}</td>
                  <td style={{ textAlign: 'right' }}>{t.state === 'active' && <button type="button" className="btn-ghost-danger" onClick={() => revoke(t)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="glass-panel" style={{ padding: 24 }}>
        <SectionHeader icon={<Plug size={18} />} title="How to use it">
          Send the token as a bearer token. Up to 60 requests per minute per token. Prompt text is never returned.
        </SectionHeader>
        <pre className="code-block">{`curl -H "Authorization: Bearer aspt_..." ${base}/api/v1/public/alerts?limit=50
curl -H "Authorization: Bearer aspt_..." ${base}/api/v1/public/usage`}</pre>
      </section>
    </motion.div>
  );
};
