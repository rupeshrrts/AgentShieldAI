import React, { useEffect, useState } from 'react';
import { ArrowRight, MailCheck } from 'lucide-react';
import { api } from '../services/api';
import { UserSession } from '../types';

interface LoginProps {
  onLoginSuccess: (session: UserSession) => void;
}

type Mode = 'signin' | 'signup' | 'forgot' | 'reset-sent';

// Public website (its own app). In development it runs on :5172; a production build links to it
// only when VITE_WEBSITE_URL is set.
const WEBSITE_URL: string | null =
  import.meta.env.VITE_WEBSITE_URL || (import.meta.env.DEV ? 'http://localhost:5172' : null);

// Internal admin console for AgentShieldAI staff (its own app and accounts). Only a link: customer
// accounts cannot sign in there. In development it runs on :5175; a production build shows the link
// only when VITE_ADMIN_CONSOLE_URL is set.
const ADMIN_CONSOLE_URL: string | null =
  import.meta.env.VITE_ADMIN_CONSOLE_URL || (import.meta.env.DEV ? 'http://localhost:5175' : null);

// The website's buttons open the portal at /#signup or /#signin. Read once at load (not in a state
// initializer, which React may run twice) and remove it from the address bar. Someone who opens the
// portal's bare address without a session is sent to the website first; email links (#verify=,
// #reset=, #invite=) still open here.
// A friend's invite link opens the portal at /#ref=<code>: show sign-up and send the code with it. The server
// ignores unknown codes, and both accounts get bonus prompt checks only after the new email is confirmed.
const REF_PATTERN = /^#ref=([A-Za-z0-9]{4,32})$/;
const REFERRAL_CODE: string | null = (() => {
  const match = REF_PATTERN.exec(window.location.hash);
  if (!match) return null;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return match[1].toLowerCase();
})();

const ENTRY: 'signup' | 'signin' | 'website' = (() => {
  if (REFERRAL_CODE) return 'signup';
  const hash = window.location.hash;
  if (hash === '#signup' || hash === '#signin') {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    // The website's "Log in" and "Sign up free" always open the form, even if this browser is still
    // signed in: drop the stored session first (runs before App reads it; the browser's password
    // manager then offers saved credentials on the sign-in form).
    api.logout();
    return hash === '#signup' ? 'signup' : 'signin';
  }
  return !hash && WEBSITE_URL && !api.getStoredSession() ? 'website' : 'signin';
})();
if (ENTRY === 'website' && WEBSITE_URL) window.location.replace(WEBSITE_URL);

/**
 * Sign in, or create an account. Individual accounts are available now (signed in straight away;
 * a confirmation email unlocks the free trial). Company workspaces are shown as "coming soon".
 * After signing in, users start the trial or choose a plan, download the extension, generate an
 * activation code and paste it into the extension.
 */
export const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
  const [mode, setMode] = useState<Mode>(ENTRY === 'signup' ? 'signup' : 'signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [signup, setSignup] = useState<{ enabled: boolean; allowed_domains: string[]; trial_days?: number; email_verification_required?: boolean } | null>(null);

  useEffect(() => {
    api.getSignupInfo().then(setSignup).catch(() => setSignup(null));
  }, []);

  const switchMode = (m: Mode) => {
    setMode(m);
    setErrorMsg(null);
    setInfoMsg(null);
    setPassword('');
    setConfirm('');
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg(null);
    try {
      onLoginSuccess(await api.login(email, password));
    } catch (err: any) {
      setErrorMsg(err.message || 'Sign-in failed. Check your email and password.');
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (password.length < 12) return setErrorMsg('Use at least 12 characters for your password.');
    if (password !== confirm) return setErrorMsg('The passwords do not match.');
    setLoading(true);
    try {
      onLoginSuccess(await api.signUp(email.trim(), password, name.trim(), REFERRAL_CODE || undefined));
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not create the account.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setLoading(true);
    try {
      await api.forgotPassword(email.trim());
      setMode('reset-sent');
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'radial-gradient(ellipse at 50% 20%, #eff6ff 0%, #f8fafc 70%)',
      padding: '20px',
    }}>
      <div className="glass-panel" style={{
        maxWidth: '420px',
        width: '100%',
        padding: '36px 32px',
        display: 'flex',
        flexDirection: 'column',
        gap: '22px',
        background: '#ffffff',
        border: '1px solid var(--border-default)',
        borderRadius: '16px',
        boxShadow: 'var(--shadow-lg)',
      }}>
        {/* Logo and Title */}
        <div style={{ textAlign: 'center' }}>
          <img
            src="/logo.png"
            alt="AgentShield"
            style={{ width: '60px', height: '60px', marginBottom: '14px', objectFit: 'contain' }}
          />
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text-main)' }}>
            {mode === 'signup'
              ? 'Create your account'
              : mode === 'reset-sent'
              ? 'Check your email'
              : mode === 'forgot'
              ? 'Reset your password'
              : 'Sign in to AgentShield'}
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
            {mode === 'signup'
              ? signup?.email_verification_required
                ? `Start free after you confirm your email: every feature for ${signup?.trial_days ?? 30} days, then the Free plan. No card needed.${REFERRAL_CODE ? ' You were invited: you both get bonus prompt checks once you confirm.' : ''}`
                : `Start free: every feature for ${signup?.trial_days ?? 30} days, then the Free plan. No card needed.${REFERRAL_CODE ? ' You were invited: you both get bonus prompt checks once you confirm your email.' : ''}`
              : mode === 'forgot'
              ? "We'll email you a link to set a new password."
              : mode === 'reset-sent'
              ? ''
              : 'AI Browser Security & Governance'}
          </p>
        </div>

        {errorMsg && (
          <div className="callout" style={{ color: 'var(--color-danger-text)', background: 'var(--color-danger-bg)', border: '1px solid var(--color-danger-border)', display: 'block' }}>
            {errorMsg}
          </div>
        )}
        {infoMsg && (
          <div className="callout" style={{ color: 'var(--color-success-text)', background: 'var(--color-success-bg)', border: '1px solid var(--color-success-border)' }}>
            {infoMsg}
          </div>
        )}

        {mode === 'reset-sent' && (
          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
            <div className="icon-tile" style={{ width: '48px', height: '48px', background: 'var(--color-primary-bg)', color: 'var(--color-primary)' }}>
              <MailCheck size={24} />
            </div>
            <p style={{ fontSize: '13.5px', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
              If an account exists for <strong>{email}</strong>, we sent a link to set a new password. It works once and
              expires in 60 minutes. Setting a new password signs you out everywhere else.
            </p>
            <button type="button" className="btn-secondary" onClick={() => switchMode('signin')} style={{ justifyContent: 'center', width: '100%' }}>
              Back to sign in
            </button>
          </div>
        )}

        {mode === 'forgot' && (
          <form onSubmit={handleForgot} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label className="field-label" htmlFor="forgot-email">Work email</label>
              <input id="forgot-email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="username" style={{ width: '100%' }} />
            </div>
            <button type="submit" className="btn-primary" disabled={loading} style={{ width: '100%', justifyContent: 'center', height: '42px' }}>
              {loading ? 'Sending...' : 'Send reset link'}
            </button>
            <button type="button" className="link-btn" onClick={() => switchMode('signin')} style={{ alignSelf: 'center' }}>Back to sign in</button>
          </form>
        )}

        {mode === 'signin' && (
          <form onSubmit={handleSignIn} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label className="field-label" htmlFor="login-email">Work email</label>
              <input id="login-email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="username" autoFocus style={{ width: '100%' }} />
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <label className="field-label" htmlFor="login-password">Password</label>
                <button type="button" className="link-btn" onClick={() => switchMode('forgot')} style={{ fontSize: '12px' }}>Forgot password?</button>
              </div>
              <input id="login-password" className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" style={{ width: '100%' }} />
            </div>
            <button type="submit" className="btn-primary" disabled={loading} style={{ width: '100%', justifyContent: 'center', height: '42px', marginTop: '4px' }}>
              <span>{loading ? 'Signing in...' : 'Sign in'}</span>
              <ArrowRight size={16} />
            </button>
          </form>
        )}

        {mode === 'signup' && (
          <form onSubmit={handleSignUp} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div className="account-type-grid" role="radiogroup" aria-label="Account type">
              <button type="button" role="radio" aria-checked="true" className="account-type selected">
                <strong>Individual</strong>
                <span>For you, on your own browsers</span>
                <span className="avail-badge">Available now</span>
              </button>
              <button type="button" role="radio" aria-checked="false" aria-disabled="true" disabled className="account-type"
                title="Company workspaces are coming soon">
                <strong>Company</strong>
                <span>Teams, employees, central billing</span>
                <span className="soon-badge">Coming soon</span>
              </button>
            </div>
            <div>
              <label className="field-label" htmlFor="signup-name">Your name</label>
              <input id="signup-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" autoComplete="name" maxLength={120} style={{ width: '100%' }} />
            </div>
            <div>
              <label className="field-label" htmlFor="signup-email">Email</label>
              <input id="signup-email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="username" style={{ width: '100%' }} />
              {signup && signup.allowed_domains.length > 0 && (
                <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  Use your {signup.allowed_domains.map((d) => '@' + d).join(' or ')} address.
                </div>
              )}
            </div>
            <div>
              <label className="field-label" htmlFor="signup-password">Choose a password</label>
              <input id="signup-password" className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" style={{ width: '100%' }} />
              <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '4px' }}>At least 12 characters.</div>
            </div>
            <div>
              <label className="field-label" htmlFor="signup-confirm">Confirm password</label>
              <input id="signup-confirm" className="input" type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" style={{ width: '100%' }} />
            </div>
            <button type="submit" className="btn-primary" disabled={loading} style={{ width: '100%', justifyContent: 'center', height: '42px', marginTop: '4px' }}>
              <span>{loading ? 'Creating account...' : 'Create account'}</span>
              <ArrowRight size={16} />
            </button>
          </form>
        )}

        {(mode === 'signin' || mode === 'signup') && signup?.enabled && (
          <div style={{ textAlign: 'center', fontSize: '13px', color: 'var(--text-muted)' }}>
            {mode === 'signin' ? (
              <>New here? <button type="button" className="link-btn" onClick={() => switchMode('signup')}>Create an account</button></>
            ) : (
              <>Already have an account? <button type="button" className="link-btn" onClick={() => switchMode('signin')}>Sign in</button></>
            )}
          </div>
        )}

        {mode === 'signin' && ADMIN_CONSOLE_URL && (
          <div style={{ borderTop: '1px solid var(--border-default)', paddingTop: '16px', textAlign: 'center', fontSize: '12.5px', color: 'var(--text-muted)' }}>
            AgentShieldAI staff?{' '}
            <a href={ADMIN_CONSOLE_URL} className="link-btn" style={{ textDecoration: 'none' }}>
              Admin login
            </a>
          </div>
        )}

        {WEBSITE_URL && (
          <a href={WEBSITE_URL} style={{ textAlign: 'center', fontSize: '12.5px', color: 'var(--text-muted)', textDecoration: 'none' }}>
            ← Back to the AgentShieldAI website
          </a>
        )}
      </div>
    </div>
  );
};
