import React, { useCallback, useEffect, useState } from 'react';
import { Building2, CreditCard, HeartPulse, LayoutDashboard, LogOut, Package, ScrollText, Tags, Users } from 'lucide-react';
import { auth, session, SESSION_ENDED } from './api';
import { Dialog, type OpenDialog } from './ui';
import type { StaffMe, StaffSession } from './types';
import { ChangePassword, SignIn } from './pages/SignIn';
import { Overview } from './pages/Overview';
import { Companies } from './pages/Companies';
import { Payments } from './pages/Payments';
import { Plans } from './pages/Plans';
import { Releases } from './pages/Releases';
import { Audit } from './pages/Audit';
import { Staff } from './pages/Staff';
import { Health } from './pages/Health';

// Invite links carry the token in the URL fragment (never sent to servers or logs); read once at load
const INVITE_TOKEN = (() => {
  const m = window.location.hash.match(/staff-invite=([\w-]+)/);
  return m ? m[1] : null;
})();

type Page = 'overview' | 'health' | 'companies' | 'payments' | 'plans' | 'releases' | 'audit' | 'staff';

const NAV: { id: Page; label: string; icon: React.ReactNode; permission: string }[] = [
  { id: 'overview', label: 'Overview', icon: <LayoutDashboard size={17} />, permission: 'metrics.read' },
  { id: 'health', label: 'Platform health', icon: <HeartPulse size={17} />, permission: 'metrics.read' },
  { id: 'companies', label: 'Accounts', icon: <Building2 size={17} />, permission: 'companies.read' },
  { id: 'payments', label: 'Payments', icon: <CreditCard size={17} />, permission: 'billing.read' },
  { id: 'plans', label: 'Plans & pricing', icon: <Tags size={17} />, permission: 'plans.read' },
  { id: 'releases', label: 'Extension releases', icon: <Package size={17} />, permission: 'releases.read' },
  { id: 'audit', label: 'Audit log', icon: <ScrollText size={17} />, permission: 'audit.read' },
  { id: 'staff', label: 'Staff & roles', icon: <Users size={17} />, permission: 'staff.manage' },
];

export const App: React.FC = () => {
  const [me, setMe] = useState<StaffMe | null>(null);
  const [checking, setChecking] = useState(Boolean(session.get()));
  const [page, setPage] = useState<Page>('overview');
  const [dialog, setDialog] = useState<React.ComponentProps<typeof Dialog> | null>(null);

  const openDialog: OpenDialog = useCallback((d) => setDialog({ ...d, onClose: () => setDialog(null) }), []);

  useEffect(() => {
    if (!session.get()) return;
    auth.me().then(setMe).catch(() => session.clear()).finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    const ended = () => setMe(null);
    window.addEventListener(SESSION_ENDED, ended);
    return () => window.removeEventListener(SESSION_ENDED, ended);
  }, []);

  const signedIn = (s: StaffSession) => {
    session.set(s.access_token);
    setMe(s.staff);
    const first = NAV.find((n) => s.staff.permissions.includes(n.permission));
    if (first) setPage(first.id);
  };

  const signOut = () => {
    session.clear();
    setMe(null);
  };

  if (checking) return <div className="auth-wrap" />;
  if (!me) return <SignIn inviteToken={INVITE_TOKEN} onSignedIn={signedIn} />;
  if (me.must_change_password) return <ChangePassword onDone={signedIn} onSignOut={signOut} />;

  const can = (permission: string) => me.permissions.includes(permission);
  const nav = NAV.filter((n) => can(n.permission));
  const current = nav.find((n) => n.id === page) ? page : nav[0]?.id;

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Internal console navigation">
        <div className="brand">
          <img src="/logo.png" alt="" />
          <div>AgentShieldAI<small>Internal console</small></div>
        </div>
        {nav.map((n) => (
          <button key={n.id} type="button" className={`nav-btn ${current === n.id ? 'active' : ''}`} onClick={() => setPage(n.id)}>
            {n.icon} {n.label}
          </button>
        ))}
        <div className="sidebar-foot">
          <strong>{me.email}</strong>
          <span>{me.role_label}</span>
          <div className="row" style={{ marginTop: 10 }}>
            <button type="button" className="nav-btn" style={{ padding: '6px 8px' }} onClick={signOut}><LogOut size={15} /> Sign out</button>
          </div>
          <button type="button" className="btn-link" style={{ color: '#e0f2fe', fontSize: 12 }}
            onClick={() => openDialog({
              title: 'Sign out everywhere?', message: 'Ends every console session of your account, including this one.',
              confirmLabel: 'Sign out everywhere', danger: true,
              onConfirm: async () => { await auth.logoutAll(); signOut(); },
            })}>
            Sign out everywhere
          </button>
          <button type="button" className="btn-link" style={{ color: '#e0f2fe', fontSize: 12 }}
            onClick={() => openDialog({
              title: 'Change your password', message: 'At least 14 characters. Your other console sessions end; this one continues.',
              fields: [
                { name: 'current', label: 'Current password', type: 'password', minLength: 1 },
                { name: 'next', label: 'New password', type: 'password', minLength: 14 },
                { name: 'confirm', label: 'Confirm new password', type: 'password', minLength: 14 },
              ],
              confirmLabel: 'Change password',
              onConfirm: async (v) => {
                if (v.next !== v.confirm) throw new Error('The new passwords do not match.');
                signedIn(await auth.changePassword(v.current, v.next));
              },
            })}>
            Change password
          </button>
        </div>
      </aside>
      <main className="main">
        {current === 'overview' && <Overview can={can} openDialog={openDialog} />}
        {current === 'health' && <Health />}
        {current === 'companies' && <Companies can={can} openDialog={openDialog} />}
        {current === 'payments' && <Payments can={can} openDialog={openDialog} />}
        {current === 'plans' && <Plans can={can} />}
        {current === 'releases' && <Releases can={can} />}
        {current === 'audit' && <Audit />}
        {current === 'staff' && <Staff me={me} openDialog={openDialog} />}
        {!current && <div className="card card-pad">Your role has no console pages yet.</div>}
      </main>
      {dialog && <Dialog {...dialog} />}
    </div>
  );
};
