import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { InviteInfo, UserSession } from '../types';

/**
 * Create an account from an emailed invite link (/#invite=<token>). The token is in the URL
 * fragment, so it is never sent to a server or written to proxy logs; it is removed from the
 * address bar as soon as the page reads it.
 */
export const AcceptInvite: React.FC<{ token: string; onDone: (s: UserSession) => void; onCancel: () => void }> = ({ token, onDone, onCancel }) => {
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getInviteInfo(token).then(setInfo).catch((e) => setError(e.message));
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 12) return setError('Use at least 12 characters.');
    if (password !== confirm) return setError('The passwords do not match.');
    setBusy(true);
    try {
      onDone(await api.acceptInvite(token, password));
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', background: 'var(--bg-primary)' }}>
      <div className="glass-panel" style={{ width: '100%', maxWidth: '420px', padding: '32px', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
          <img src="/logo.png" alt="AgentShield" width={52} height={52} style={{ marginBottom: '12px' }} />
          <h1 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-main)' }}>Create your AgentShield account</h1>
          {info && (
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '6px' }}>
              {info.organization_name} invited <strong>{info.email}</strong>
            </p>
          )}
        </div>

        {!info && !error && <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Checking your invite...</p>}

        {info && (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <input type="email" autoComplete="username" value={info.email} readOnly hidden />
            <div>
              <label className="field-label" htmlFor="new-password">Choose a password</label>
              <input id="new-password" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ width: '100%' }} />
              <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '4px' }}>At least 12 characters.</div>
            </div>
            <div>
              <label className="field-label" htmlFor="confirm-password">Confirm password</label>
              <input id="confirm-password" className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required style={{ width: '100%' }} />
            </div>
            <button type="submit" className="btn-primary" disabled={busy} style={{ justifyContent: 'center', height: '40px' }}>
              {busy ? 'Creating account...' : 'Create account'}
            </button>
          </form>
        )}

        {error && <div style={{ marginTop: '12px', fontSize: '12.5px', color: 'var(--color-danger-text)', textAlign: 'center' }}>{error}</div>}
        <div style={{ textAlign: 'center', marginTop: '16px' }}>
          <button type="button" className="link-btn" onClick={onCancel}>Back to sign in</button>
        </div>
      </div>
    </div>
  );
};
