import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { KeyRound, ShieldCheck, Smartphone } from 'lucide-react';
import { auth, type LoginStep } from '../api';
import { Alert } from '../ui';
import type { StaffSession } from '../types';

type Stage = 'password' | 'invite' | 'mfa' | 'setup' | 'codes';

/**
 * Staff sign-in. A session is only issued after the authenticator step; first-time staff must
 * enrol an authenticator app (QR code or manual key) and save their recovery codes.
 */
export const SignIn: React.FC<{ inviteToken: string | null; onSignedIn: (s: StaffSession) => void }> = ({ inviteToken, onSignedIn }) => {
  const [stage, setStage] = useState<Stage>(inviteToken ? 'invite' : 'password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [step, setStep] = useState<LoginStep | null>(null);
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [pending, setPending] = useState<StaffSession | null>(null);
  const [invite, setInvite] = useState<{ email: string; role_label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [forgot, setForgot] = useState(false);

  useEffect(() => {
    if (inviteToken) auth.inviteInfo(inviteToken).then(setInvite).catch((e) => setError(e.message));
  }, [inviteToken]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const goToStep = async (s: LoginStep) => {
    setStep(s);
    setCode('');
    if (s.step === 'mfa') {
      setStage('mfa');
      return;
    }
    const data = await auth.mfaSetup(s.token);
    setSetup({ secret: data.secret, qr: await QRCode.toDataURL(data.otpauth_uri, { margin: 1, width: 196 }) });
    setStage('setup');
  };

  const submitPassword = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => goToStep(await auth.login(email.trim(), password)));
  };

  const submitInvite = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 14) return setError('Use at least 14 characters.');
    if (password !== confirm) return setError('The passwords do not match.');
    run(async () => {
      const s = await auth.acceptInvite(inviteToken || '', password);
      window.history.replaceState(null, '', window.location.pathname);
      await goToStep(s);
    });
  };

  const submitCode = (e: React.FormEvent) => {
    e.preventDefault();
    if (!step) return;
    run(async () => onSignedIn(await auth.mfaVerify(step.token, useRecovery ? { recovery_code: code } : { code })));
  };

  const submitEnrol = (e: React.FormEvent) => {
    e.preventDefault();
    if (!step) return;
    run(async () => {
      const res = await auth.mfaEnable(step.token, code);
      setCodes(res.recovery_codes);
      setPending(res.session);
      setStage('codes');
    });
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <img src="/logo.png" alt="AgentShieldAI" width={40} height={40} />
          <span className="internal-badge">INTERNAL</span>
        </div>

        {stage === 'password' && (
          <form className="stack" onSubmit={submitPassword}>
            <div>
              <h1>AgentShieldAI staff sign-in</h1>
              <p className="page-sub">For AgentShieldAI employees only. Customers sign in to the company portal.</p>
            </div>
            <div>
              <label className="label" htmlFor="email">Work email</label>
              <input id="email" className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <label className="label" htmlFor="password">Password</label>
                <button type="button" className="btn-link" onClick={() => setForgot(!forgot)}>Forgot password?</button>
              </div>
              <input id="password" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {forgot && (
              <Alert kind="info">
                Staff passwords are not reset by email. Ask a platform owner to reset it (<strong>Staff &amp; roles → Reset password</strong>);
                you get a one-time password to change at sign-in. If you are the only platform owner, run on the server or a PC with
                its database settings: <code>python -m app.cli reset-staff-password --email you@company.com</code> (in <code>backend</code>).
              </Alert>
            )}
            <Alert kind="error">{error}</Alert>
            <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Checking...' : 'Continue'}</button>
            <p className="card-note">Lost your authenticator? Ask a platform owner to reset it, or use a recovery code at the next step.</p>
          </form>
        )}

        {stage === 'invite' && (
          <form className="stack" onSubmit={submitInvite}>
            <div>
              <h1>Set up your staff account</h1>
              <p className="page-sub">{invite ? <>{invite.email} · {invite.role_label}</> : 'Checking your invite...'}</p>
            </div>
            <div>
              <label className="label" htmlFor="new-password">Choose a password</label>
              <input id="new-password" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <div className="cell-sub">At least 14 characters. Next you'll set up an authenticator app.</div>
            </div>
            <div>
              <label className="label" htmlFor="confirm-password">Confirm password</label>
              <input id="confirm-password" className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
            <Alert kind="error">{error}</Alert>
            <button className="btn btn-primary" type="submit" disabled={busy || !invite}>{busy ? 'Saving...' : 'Set password'}</button>
          </form>
        )}

        {stage === 'mfa' && (
          <form className="stack" onSubmit={submitCode}>
            <div className="row"><Smartphone size={20} /><h1>Authenticator code</h1></div>
            <p className="page-sub">{useRecovery ? 'Enter one of your saved recovery codes. Each works once.' : 'Enter the 6-digit code from your authenticator app.'}</p>
            <input className="input mono" inputMode={useRecovery ? 'text' : 'numeric'} autoComplete="one-time-code" autoFocus
              placeholder={useRecovery ? 'xxxx-xxxx-xxxx' : '123456'} value={code} onChange={(e) => setCode(e.target.value)} />
            <Alert kind="error">{error}</Alert>
            <button className="btn btn-primary" type="submit" disabled={busy || !code.trim()}>{busy ? 'Verifying...' : 'Sign in'}</button>
            <button type="button" className="btn-link" onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(''); }}>
              {useRecovery ? 'Use an authenticator code instead' : 'Use a recovery code'}
            </button>
          </form>
        )}

        {stage === 'setup' && setup && (
          <form className="stack" onSubmit={submitEnrol}>
            <div className="row"><ShieldCheck size={20} /><h1>Set up your authenticator</h1></div>
            <p className="page-sub">Two-step verification is required for every staff account. Scan this code with Google Authenticator, Microsoft Authenticator or a similar app.</p>
            <div className="qr"><img src={setup.qr} alt="Authenticator QR code" width={196} height={196} /></div>
            <details>
              <summary className="card-note" style={{ cursor: 'pointer' }}>Can't scan? Enter this key instead</summary>
              <div className="tag" style={{ display: 'block', marginTop: 8, wordBreak: 'break-all' }}>{setup.secret.match(/.{1,4}/g)?.join(' ')}</div>
            </details>
            <div>
              <label className="label" htmlFor="enrol-code">Code shown in the app</label>
              <input id="enrol-code" className="input mono" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            <Alert kind="error">{error}</Alert>
            <button className="btn btn-primary" type="submit" disabled={busy || code.trim().length < 6}>{busy ? 'Verifying...' : 'Turn on two-step verification'}</button>
          </form>
        )}

        {stage === 'codes' && pending && (
          <div className="stack">
            <div className="row"><KeyRound size={20} /><h1>Save your recovery codes</h1></div>
            <p className="page-sub">If you lose your phone, each code signs you in once. They are shown only now; store them in a password manager.</p>
            <div className="codes">{codes.map((c) => <span key={c}>{c}</span>)}</div>
            <div className="row">
              <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard.writeText(codes.join('\n'))}>Copy codes</button>
            </div>
            <button className="btn btn-primary" type="button" onClick={() => onSignedIn(pending)}>I saved them, continue</button>
          </div>
        )}
      </div>
    </div>
  );
};

/** Shown after sign-in when the account still has a temporary password (new owner or a password reset). */
export const ChangePassword: React.FC<{ onDone: (s: StaffSession) => void; onSignOut: () => void }> = ({ onDone, onSignOut }) => {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next.length < 14) return setError('Use at least 14 characters.');
    if (next !== confirm) return setError('The new passwords do not match.');
    setBusy(true);
    setError('');
    try {
      onDone(await auth.changePassword(current, next));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div>
          <h1>Replace your temporary password</h1>
          <p className="page-sub">This account has a one-time password. Choose your own before using the console.</p>
        </div>
        <div>
          <label className="label" htmlFor="cur">Temporary password</label>
          <input id="cur" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="new">New password</label>
          <input id="new" className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          <div className="cell-sub">At least 14 characters.</div>
        </div>
        <div>
          <label className="label" htmlFor="conf">Confirm new password</label>
          <input id="conf" className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <Alert kind="error">{error}</Alert>
        <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save password'}</button>
        <button type="button" className="btn-link" onClick={onSignOut}>Sign out</button>
      </form>
    </div>
  );
};
