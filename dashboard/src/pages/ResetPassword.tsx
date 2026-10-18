import React, { useState } from 'react';
import { api } from '../services/api';
import { UserSession } from '../types';

/** Opened from the password-reset email (/#reset=<token>, kept out of server logs). */
export const ResetPassword: React.FC<{ token: string; onDone: (s: UserSession) => void; onCancel: () => void }> = ({ token, onDone, onCancel }) => {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 12) return setError('Use at least 12 characters.');
    if (password !== confirm) return setError('The passwords do not match.');
    setBusy(true);
    try {
      onDone(await api.resetPassword(token, password));
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
          <h1 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-main)' }}>Set a new password</h1>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '6px' }}>This signs you out on every other device.</p>
        </div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div>
            <label className="field-label" htmlFor="reset-password">New password</label>
            <input id="reset-password" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ width: '100%' }} />
            <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '4px' }}>At least 12 characters.</div>
          </div>
          <div>
            <label className="field-label" htmlFor="reset-confirm">Confirm new password</label>
            <input id="reset-confirm" className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required style={{ width: '100%' }} />
          </div>
          <button type="submit" className="btn-primary" disabled={busy} style={{ justifyContent: 'center', height: '40px' }}>
            {busy ? 'Saving...' : 'Save new password'}
          </button>
        </form>
        {error && <div style={{ marginTop: '12px', fontSize: '12.5px', color: 'var(--color-danger-text)', textAlign: 'center' }}>{error}</div>}
        <div style={{ textAlign: 'center', marginTop: '16px' }}>
          <button type="button" className="link-btn" onClick={onCancel}>Back to sign in</button>
        </div>
      </div>
    </div>
  );
};
