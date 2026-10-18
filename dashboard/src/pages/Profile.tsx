import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { LogOut, MailCheck, ShieldCheck, UserCircle2 } from 'lucide-react';
import { SectionHeader } from '../components/SectionHeader';
import { api } from '../services/api';
import { Me, UserSession } from '../types';

/** Profile & security for the signed-in person: name, email confirmation, password, sessions. */
export const Profile: React.FC<{ session: UserSession; onSignedOut: () => void; onProfileChanged: () => void }> = ({ session, onSignedOut, onProfileChanged }) => {
  const [me, setMe] = useState<Me | null>(null);
  const [name, setName] = useState('');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    api.getMe().then((m) => { setMe(m); setName(m.display_name || ''); }).catch((e) => setError(e.message));
  }, []);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setError('');
    setNotice('');
    try {
      await fn();
      setNotice(ok);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const savePassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (next.length < 12) return setError('Use at least 12 characters for your new password.');
    if (next !== confirm) return setError('The new passwords do not match.');
    run(async () => { await api.changePassword(current, next); setCurrent(''); setNext(''); setConfirm(''); },
      'Password changed. Your other sessions were signed out.');
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 760 }}>
      <div>
        <h1 className="page-title">Profile &amp; security</h1>
        <p className="page-subtitle">{session.email}</p>
      </div>
      {error && <div className="callout callout-error">{error}</div>}
      {notice && <div className="callout callout-success">{notice}</div>}

      <section className="glass-panel" style={{ padding: 24 }}>
        <SectionHeader icon={<UserCircle2 size={18} />} title="Profile" />
        <form className="row-form" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.updateProfile(name); onProfileChanged(); }, 'Profile saved.'); }}>
          <label className="field-label" style={{ flex: 1 }}>Your name
            <input className="input" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} />
          </label>
          <button className="btn-primary" type="submit" style={{ alignSelf: 'flex-end' }}>Save</button>
        </form>
        <div className="cell-sub" style={{ marginTop: 10 }}>Account type: {me?.account_type === 'COMPANY' ? 'Company workspace' : 'Individual'}</div>
      </section>

      <section className="glass-panel" style={{ padding: 24 }}>
        <SectionHeader icon={<MailCheck size={18} />} title="Email" />
        {me?.email_verified ? (
          <div className="row-form"><span className="status-pill status-active"><span className="status-dot" /> Confirmed</span> <span className="cell-sub">{session.email}</span></div>
        ) : (
          <div className="row-form">
            <span className="status-pill status-pending"><span className="status-dot" /> Not confirmed</span>
            <span className="cell-sub">
              {me?.email_verification_required ? 'Confirm your email to start your free trial.' : 'Optional: confirm your email to receive invite-a-friend bonuses.'}
            </span>
            <button type="button" className="btn-secondary btn-sm" onClick={() => run(() => api.resendVerification(session.email), 'A confirmation link is on its way.')}>
              {me?.email_verification_required ? 'Send a new link' : 'Send confirmation link'}
            </button>
          </div>
        )}
      </section>

      <section className="glass-panel" style={{ padding: 24 }}>
        <SectionHeader icon={<ShieldCheck size={18} />} title="Change password" />
        <form onSubmit={savePassword} className="form-grid">
          <label className="field-label">Current password<input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} style={{ width: '100%' }} /></label>
          <label className="field-label">New password<input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} style={{ width: '100%' }} /></label>
          <label className="field-label">Confirm new password<input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={{ width: '100%' }} /></label>
          <div><button className="btn-primary" type="submit" disabled={!current || !next}>Change password</button></div>
        </form>
      </section>

      <section className="glass-panel" style={{ padding: 24 }}>
        <SectionHeader icon={<LogOut size={18} />} title="Sessions">
          Signs you out of the portal on every device. Browsers connected with the extension stay protected; manage them in Connect browser.
        </SectionHeader>
        <button type="button" className="btn-ghost-danger" onClick={async () => {
          if (!window.confirm('Sign out of the portal on every device, including this one?')) return;
          await api.logoutEverywhere();
          onSignedOut();
        }}><LogOut size={14} /> Sign out everywhere</button>
      </section>
    </motion.div>
  );
};
