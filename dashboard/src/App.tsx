/**
 * AgentShield Administrator Dashboard - Root Application Component.
 *
 * Manages operator session authentication, active navigation tabs, periodic
 * polling of real backend data (policies, metrics, protected browsers), and
 * renders the corresponding view. Every number shown comes from the API.
 */

import React, { useState, useEffect } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { CreditCard, Lock, ShieldAlert } from 'lucide-react';
import { Navbar } from './components/Navbar';
import { Sidebar, NavTab } from './components/Sidebar';
import { Overview } from './pages/Overview';
import { PolicyEditor } from './pages/PolicyEditor';
import { DomainManager } from './pages/DomainManager';
import { SecurityEvents } from './pages/SecurityEvents';
import { InteractiveSandbox } from './pages/InteractiveSandbox';
import { Limitations } from './pages/Limitations';
import { Login } from './pages/Login';
import { Deployment } from './pages/Deployment';
import { Endpoints } from './pages/Endpoints';
import { AuditLog } from './pages/AuditLog';
import { DemoGuide } from './pages/DemoGuide';
import { Users } from './pages/Users';
import { MyActivation } from './pages/MyActivation';
import { AcceptInvite } from './pages/AcceptInvite';
import { VerifyEmail } from './pages/VerifyEmail';
import { ResetPassword } from './pages/ResetPassword';
import { Account } from './pages/Account';
import { Download } from './pages/Download';
import { Usage } from './pages/Usage';
import { ApiTokens } from './pages/ApiTokens';
import { Profile } from './pages/Profile';
import { CompanyComingSoon } from './pages/CompanyComingSoon';
import { api, SESSION_EXPIRED_EVENT } from './services/api';
import { LOCKED_STATES } from './utils/format';
import { EndpointSummary, Entitlement, Me, MetricsSummary, OrgSettings, Policy, UserSession } from './types';

// Invite links carry their token in the URL fragment (#invite=...). Read it once when the app
// loads (not in a state initializer, which React may run twice) and remove it from the address bar.
// Email confirmation links work the same way (#verify=...).
const tokenFromUrl = (name: string): string | null => {
  const match = window.location.hash.match(new RegExp(`${name}=([\\w-]+)`));
  if (match) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return match ? match[1] : null;
};
const INVITE_TOKEN_FROM_URL = tokenFromUrl('invite');
const VERIFY_TOKEN_FROM_URL = tokenFromUrl('verify');
const RESET_TOKEN_FROM_URL = tokenFromUrl('reset');

/** Open the activation page from the browser popup, including after sign-in. */
const homeTab = (): NavTab => window.location.hash === '#activation' ? 'activation' : 'account';

export const App: React.FC = () => {
  // Session state initialized from persistent localStorage
  const [session, setSession] = useState<UserSession | null>(() => api.getStoredSession());
  const [activeTab, setActiveTab] = useState<NavTab>(homeTab);
  const [inviteToken, setInviteToken] = useState<string | null>(INVITE_TOKEN_FROM_URL);
  const [verifyToken, setVerifyToken] = useState<string | null>(VERIFY_TOKEN_FROM_URL);
  const [resetToken, setResetToken] = useState<string | null>(RESET_TOKEN_FROM_URL);
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);

  // Shared state synchronized across views
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [policyVersion, setPolicyVersion] = useState<number>(1);
  const [domainCount, setDomainCount] = useState<number>(0);
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointSummary | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [orgSettings, setOrgSettings] = useState<OrgSettings | null>(null);

  const isAdmin = session?.role === 'ADMIN';
  const isEmployee = session?.role === 'EMPLOYEE';
  // Until the account has chosen a plan (Free plan, trial, paid plan or credits) only Account & plan and
  // Profile & security open; everything else, including Download and Connect browser, is locked.
  // The server enforces the same rule for downloads and activation codes.
  const noPlan = !isEmployee && entitlement?.state === 'NONE';
  const OPEN_WITHOUT_PLAN: NavTab[] = ['account', 'profile'];
  const ALL_TABS: NavTab[] = ['overview', 'policies', 'domains', 'events', 'endpoints', 'audit', 'sandbox', 'deployment', 'demo',
    'limitations', 'users', 'activation', 'download', 'usage', 'api', 'company'];
  const lockedTabs: NavTab[] = noPlan ? ALL_TABS.filter((t) => !OPEN_WITHOUT_PLAN.includes(t)) : [];
  const pageLocked = noPlan && !OPEN_WITHOUT_PLAN.includes(activeTab);
  // The live /auth/me answer wins over the stored session (e.g. right after confirming the email)
  const accountType = me?.account_type || session?.account_type || 'COMPANY';
  // When the server does not require a confirmed email (default since 2.4.1) nothing waits for it
  const verificationRequired = me ? me.email_verification_required === true : session?.email_verification_required === true;
  const emailVerified = !verificationRequired || (me ? me.email_verified !== false : session?.email_verified !== false);
  const [resendNote, setResendNote] = useState('');
  // False on a local test server without SMTP: confirmation links are printed in its terminal
  const [emailDelivery, setEmailDelivery] = useState(true);
  useEffect(() => {
    if (session && !emailVerified) api.getSignupInfo().then((i) => setEmailDelivery(i.email_delivery !== false)).catch(() => undefined);
  }, [session, emailVerified]);
  const LOCAL_EMAIL_NOTE = 'Local test server: emails are not sent. Open the confirmation link printed in the terminal where you ran npm start (look for [backend] DEV EMAIL).';

  /**
   * Refreshes dashboard statistics and policy metadata from the backend.
   * Employee accounts can only see their own activation, so nothing else is requested for them.
   */
  const loadData = async () => {
    if (!session) return;
    api.getBillingStatus().then((s) => setEntitlement(s.entitlement)).catch(() => undefined);
    if (isEmployee) {
      api.getMe().then(setMe).catch(() => undefined);
      return;
    }
    const results = await Promise.allSettled([
      api.getPolicies(),
      api.getMetricsSummary(),
      api.getDomains(),
      api.getEndpoints(),
      api.getMe(),
      api.getOrgSettings(),
    ]);
    const [pol, met, dom, end, who, st] = results;
    if (pol.status === 'fulfilled') {
      setPolicies(pol.value.policies);
      setPolicyVersion(pol.value.policy_version);
    }
    if (met.status === 'fulfilled') setMetrics(met.value);
    if (dom.status === 'fulfilled') setDomainCount(dom.value.total || 0);
    if (end.status === 'fulfilled') setEndpoints(end.value);
    if (who.status === 'fulfilled') setMe(who.value);
    if (st.status === 'fulfilled') setOrgSettings(st.value);
  };

  // Poll for live updates every 10 seconds while an active session exists
  useEffect(() => {
    if (session) {
      loadData();
      const interval = setInterval(loadData, 10000);
      return () => clearInterval(interval);
    }
  }, [session]);

  // Return to the login screen when the backend rejects the stored session
  useEffect(() => {
    const onExpired = () => setSession(null);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  const handleLogout = () => {
    api.logout();
    setSession(null);
  };

  const signedIn = (s: UserSession) => {
    setActiveTab(homeTab());
    setSession(s);
  };

  // Setting a new password from an emailed reset link (signs the user in)
  if (resetToken) {
    return (
      <ResetPassword
        token={resetToken}
        onDone={(s) => {
          setResetToken(null);
          signedIn(s);
        }}
        onCancel={() => setResetToken(null)}
      />
    );
  }

  // Confirming a self-registered account's email (signs the user in)
  if (verifyToken) {
    return (
      <VerifyEmail
        token={verifyToken}
        onDone={(s) => {
          setVerifyToken(null);
          signedIn(s);
        }}
        onCancel={() => setVerifyToken(null)}
      />
    );
  }

  // Creating an account from an emailed invite
  if (inviteToken) {
    return (
      <AcceptInvite
        token={inviteToken}
        onDone={(s) => {
          setInviteToken(null);
          setActiveTab('account');
          setSession(s);
        }}
        onCancel={() => setInviteToken(null)}
      />
    );
  }

  // If unauthenticated, display the login form
  if (!session) {
    return <Login onLoginSuccess={signedIn} />;
  }

  return (
    <MotionConfig reducedMotion="user">
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)' }}>
      <Navbar session={session} onLogout={handleLogout} policyVersion={isEmployee ? undefined : policyVersion} />

      {orgSettings?.demo_mode && (
        <div role="note" style={{ background: '#fffbeb', borderBottom: '1px solid var(--color-warning-border)', color: 'var(--color-warning-text)', fontSize: '12.5px', padding: '8px 28px' }}>
          <strong>Demo environment.</strong> Use synthetic test data only. Results shown are real events from enrolled browsers; nothing is simulated.
          {' '}
          <button onClick={() => setActiveTab('demo')} style={{ background: 'none', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', fontSize: 'inherit', padding: 0 }}>
            Open the guided demo
          </button>
        </div>
      )}

      {!emailVerified && (
        <div role="status" className="verify-banner">
          <ShieldAlert size={15} />
          <span>{resendNote || (emailDelivery
            ? `Confirm your email (${session.email}) to start your free trial. Check your inbox for the link.`
            : LOCAL_EMAIL_NOTE)}</span>
          <button onClick={() => api.resendVerification(session.email)
            .then(() => setResendNote(emailDelivery ? 'A new confirmation link is on its way.' : `A new link was printed. ${LOCAL_EMAIL_NOTE}`))
            .catch((e) => setResendNote(e.message))}>
            Send a new link
          </button>
        </div>
      )}

      {entitlement && LOCKED_STATES.includes(entitlement.state) && !['account', 'usage'].includes(activeTab) && (
        <div role="alert" className="expired-banner">
          <ShieldAlert size={15} />
          <span>
            {entitlement.state === 'EXPIRED'
              ? 'Your AgentShield plan has ended: browsers are locked and AI sites are blocked.'
              : entitlement.state === 'LIMIT_REACHED'
              ? 'This month\'s included prompt checks are used up: browsers are locked until you buy credits or upgrade.'
              : entitlement.state === 'CAP_REACHED'
              ? 'Your monthly usage limit is reached: browsers are locked until you raise it or the month ends.'
              : entitlement.state === 'NO_CREDITS'
              ? 'Your prepaid credits are used up: browsers are locked until you buy more.'
              : 'Your AgentShield access is suspended.'}
          </span>
          <button onClick={() => setActiveTab(entitlement.state === 'CAP_REACHED' ? 'usage' : 'account')}>
            {entitlement.state === 'CAP_REACHED' ? 'Change limit' : ['SUSPENDED', 'REVOKED'].includes(entitlement.state) ? 'Details' : 'Choose a plan'}
          </button>
        </div>
      )}

      {entitlement?.state === 'FREE_PAUSED' && !['account', 'usage'].includes(activeTab) && (
        <div role="status" className="expired-banner">
          <ShieldAlert size={15} />
          <span>
            Protection paused: this month's free prompt checks are used. AI sites and website controls keep working; prompt checks
            resume {entitlement.resets_at ? `on ${new Date(entitlement.resets_at).toLocaleDateString([], { dateStyle: 'medium' })}` : 'next month'}.
          </span>
          <button onClick={() => setActiveTab('account')}>Upgrade</button>
        </div>
      )}

      {me?.using_default_password && (
        <div role="alert" className="alert-bar">
          <ShieldAlert size={15} />
          <span>You are signed in with the default admin password.</span>
          <button onClick={() => setActiveTab('deployment')} className="alert-bar-action">
            Change password
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, alignItems: 'flex-start' }}>
        <Sidebar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          eventCount={metrics?.total_events}
          policyCount={policies.filter((p) => p.enabled).length}
          domainCount={domainCount}
          endpoints={endpoints}
          demoMode={orgSettings?.demo_mode}
          role={session.role}
          accountType={accountType}
          lockedTabs={lockedTabs}
        />

        <main style={{ flex: 1, minWidth: 0, padding: '28px 32px', maxWidth: '1400px' }}>
          <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
          {pageLocked ? (
            <section className="glass-panel plan-required">
              <div className="plan-required-icon"><Lock size={24} /></div>
              <h1 className="page-title" style={{ fontSize: '22px' }}>Choose a plan to get started</h1>
              <p className="page-subtitle" style={{ marginTop: 8 }}>
                Downloading the extension, connecting your browser and everything else here unlock once your account has a plan:
                the Free plan, the free trial, a paid plan or credits.
              </p>
              <button type="button" className="btn-primary" style={{ marginTop: 20 }} onClick={() => setActiveTab('account')}>
                <CreditCard size={15} /> Go to Account &amp; plan
              </button>
            </section>
          ) : (<>
          {activeTab === 'overview' && (
            <Overview metrics={metrics} endpoints={endpoints} me={me} isAdmin={isAdmin} onNavigate={setActiveTab} />
          )}
          {activeTab === 'policies' && (
            <PolicyEditor policies={policies} policyVersion={policyVersion} isAdmin={isAdmin} onRefresh={loadData} />
          )}
          {activeTab === 'domains' && <DomainManager isAdmin={isAdmin} endpoints={endpoints} />}
          {activeTab === 'events' && <SecurityEvents onBackToOverview={() => setActiveTab('overview')} />}
          {activeTab === 'endpoints' && <Endpoints endpoints={endpoints} onRefresh={loadData} onNavigate={setActiveTab} />}
          {activeTab === 'audit' && <AuditLog />}
          {activeTab === 'sandbox' && <InteractiveSandbox />}
          {activeTab === 'deployment' && <Deployment isAdmin={isAdmin} onChanged={loadData} onNavigate={setActiveTab} />}
          {activeTab === 'users' && isAdmin && accountType === 'COMPANY' && <Users currentUserId={session.user_id} />}
          {activeTab === 'usage' && <Usage isAdmin={isAdmin} onNavigate={setActiveTab} />}
          {activeTab === 'api' && !isEmployee && <ApiTokens />}
          {activeTab === 'profile' && <Profile session={session} onSignedOut={() => setSession(null)} onProfileChanged={loadData} />}
          {activeTab === 'company' && <CompanyComingSoon />}
          {activeTab === 'activation' && <MyActivation email={session.email} entitlement={entitlement} onNavigate={setActiveTab} />}
          {activeTab === 'account' && <Account session={session} onNavigate={setActiveTab} onSignedOut={() => setSession(null)} emailVerified={emailVerified} emailDelivery={emailDelivery} onPlanChanged={loadData} />}
          {activeTab === 'download' && <Download onNavigate={setActiveTab} individual={accountType === 'INDIVIDUAL'} />}
          {activeTab === 'demo' && <DemoGuide onNavigate={setActiveTab} />}
          {activeTab === 'limitations' && <Limitations />}
          </>)}
          </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
    </MotionConfig>
  );
};

export default App;
