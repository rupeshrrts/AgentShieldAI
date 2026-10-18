import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Bell, CheckCircle2, Circle, Copy, CreditCard, Download, Gift, KeyRound, Lock, LogOut, Mail, Monitor, Receipt, ShieldCheck, UserCircle2, Users } from 'lucide-react';
import { SectionHeader } from '../components/SectionHeader';
import { NavTab } from '../components/Sidebar';
import { api } from '../services/api';
import { payForPlan } from '../services/razorpayCheckout';
import { AuthorizedDevice, BillingOrderRow, BillingStatus, PaymentConfig, PlanInfo, ReferralInfo, SubscriptionInfo, UserSession } from '../types';
import { ACCESS_STATES, ACTIVE_STATES, STATE_CLASS, STATE_LABEL, formatDate, formatMoney, parseUtc, planDuration } from '../utils/format';

interface Props {
  session: UserSession;
  onNavigate: (tab: NavTab) => void;
  onSignedOut: () => void;
  /** From the server (/auth/me); the free trial needs a confirmed email. */
  emailVerified?: boolean;
  /** False on a local test server without SMTP (links are printed in its terminal). */
  emailDelivery?: boolean;
  /** Called after a plan is chosen, so the rest of the portal unlocks at once */
  onPlanChanged?: () => void;
}

const PLAN_NAMES: Record<string, string> = { free: 'Free', trial: 'Free trial', monthly: 'Monthly', six_month: '6 months', annual: 'Annual', internal: 'Internal licence' };

/**
 * The customer's home: plan status (from the server), free-trial claim, setup steps, plans,
 * payments (Razorpay), billing history, licence history, notices and account security.
 */
export const Account: React.FC<Props> = ({ session, onNavigate, onSignedOut, emailVerified = true, emailDelivery = true, onPlanChanged }) => {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const [devices, setDevices] = useState<AuthorizedDevice[]>([]);
  const [payConfig, setPayConfig] = useState<PaymentConfig | null>(null);
  const [orders, setOrders] = useState<BillingOrderRow[]>([]);
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [paying, setPaying] = useState<string | null>(null);
  const [referrals, setReferrals] = useState<ReferralInfo | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    try {
      const [s, p, d, c, o, sub] = await Promise.all([
        api.getBillingStatus(), api.getPlans(), api.getMyDevices(), api.getPaymentConfig(), api.getBillingOrders(), api.getSubscription(),
      ]);
      setStatus(s);
      setPlans(p);
      setDevices(d);
      setPayConfig(c);
      setOrders(o);
      setSubscription(sub);
    } catch (e: any) {
      setError(e.message);
    }
    // Invite friends (individual accounts); optional, so a failure does not hide the page
    api.getReferrals().then(setReferrals).catch(() => setReferrals(null));
  };

  const copyInvite = async () => {
    if (!referrals?.link) return;
    try {
      await navigator.clipboard.writeText(referrals.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy the link. Select it and copy it by hand.');
    }
  };

  const buy = async (plan: PlanInfo) => {
    setError('');
    setNotice('');
    setPaying(plan.code);
    try {
      const outcome = await payForPlan(plan.code);
      if (outcome.status === 'paid') {
        setNotice(`Payment received${outcome.receipt_number ? ` (receipt ${outcome.receipt_number})` : ''}. Your ${plan.name} plan is active; browsers reconnect by themselves.`);
      } else if (outcome.status === 'pending') {
        setNotice(outcome.message || 'Payment received by Razorpay. Your plan activates as soon as it is confirmed.');
      } else if (outcome.status === 'failed') {
        setError(outcome.message);
      }
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setPaying(null);
    }
  };

  const cancelSubscription = async () => {
    if (!window.confirm('Stop automatic monthly renewals? Your plan stays active until the end of the period already paid.')) return;
    setError('');
    try {
      await api.cancelSubscription();
      setNotice('Automatic renewal cancelled. Your plan stays active until the end of the paid period.');
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const openReceipt = async (paymentId: string) => {
    try {
      await api.openReceipt(paymentId);
    } catch (e: any) {
      setError(e.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const claim = async () => {
    setError('');
    setClaiming(true);
    try {
      const licence = await api.claimTrial();
      setNotice(`Your free trial is active until ${formatDate(licence.expires_at)}. Next: download the extension and connect your browser.`);
      await load();
      onPlanChanged?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setClaiming(false);
    }
  };

  const startFree = async () => {
    setError('');
    setClaiming(true);
    try {
      await api.startFreePlan();
      setNotice('Free plan started. Next: download the extension and connect your browser.');
      await load();
      onPlanChanged?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setClaiming(false);
    }
  };

  // "Start free": the trial while it can still be claimed (Free forever follows when it ends), else the Free plan
  const startFreeAny = () => (status?.trial.eligible ? claim() : startFree());

  const resendLink = async () => {
    setError('');
    try {
      await api.resendVerification(session.email);
      setNotice(emailDelivery
        ? `A new confirmation link is on its way to ${session.email}. Open it, then come back to start your free trial.`
        : 'Local test server: emails are not sent. The new confirmation link is printed in the terminal where you ran npm start (look for [backend] DEV EMAIL). Open it in this browser, then start your free trial.');
    } catch (e: any) {
      setError(e.message);
    }
  };

  const signOutEverywhere = async () => {
    if (!window.confirm('Sign out of the portal on every device, including this one?')) return;
    await api.logoutEverywhere();
    onSignedOut();
  };

  if (!status) {
    return <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>{error || 'Loading your account...'}</div>;
  }

  const ent = status.entitlement;
  const active = ACTIVE_STATES.includes(ent.state);
  // Browsers may stay connected (also while free prompt checks are paused)
  const connectedOk = ACCESS_STATES.includes(ent.state);
  const credits = ent.credit_balance ?? 0;
  const isFree = ent.state === 'FREE_ACTIVE' || ent.state === 'FREE_PAUSED';
  const freeUsed = ent.included_checks_used ?? 0;
  const freeLimit = ent.check_limit ?? 0;
  const resets = ent.resets_at ? formatDate(ent.resets_at) : 'the 1st of next month';
  const browsers = `${ent.devices_used} of ${ent.device_limit} browser${ent.device_limit === 1 ? '' : 's'} in use`;
  const headline: Record<string, string> = {
    FREE_ACTIVE: 'Free plan',
    FREE_PAUSED: 'Protection paused',
    CREDITS_ACTIVE: 'Pay as you go',
    LIMIT_REACHED: 'Monthly prompt checks used up',
    CAP_REACHED: 'Your monthly limit is reached',
    NO_CREDITS: 'Your credits are used up',
    EXPIRED: 'Your plan has ended',
    NONE: 'No active plan yet',
  };
  const subline: Record<string, string> = {
    FREE_ACTIVE: `${freeUsed.toLocaleString()} of ${freeLimit.toLocaleString()} free prompt checks used this month · resets ${resets} · ${browsers}`
      + (credits > 0 ? ` · ${credits.toLocaleString()} bonus checks` : ''),
    FREE_PAUSED: `This month's ${freeLimit.toLocaleString()} free prompt checks are used. AI sites and website controls keep working; prompt checks resume on ${resets}. Upgrade or buy credits to resume now.`,
    CREDITS_ACTIVE: `${credits.toLocaleString()} prompt checks left · ${ent.devices_used} of ${ent.device_limit} devices in use`,
    LIMIT_REACHED: 'Browsers are locked until you buy credits or upgrade. Unused credits are used before the next month starts.',
    CAP_REACHED: 'You set a monthly limit and reached it. Raise it in Usage & credits to continue now.',
    NO_CREDITS: 'Browsers are locked. Buy credits or choose a plan; browsers reconnect by themselves.',
    EXPIRED: `Ended ${formatDate(ent.expires_at)}. Browsers are locked until a plan is active; they reconnect by themselves afterwards.`,
    NONE: status.trial.eligible
      ? `Start free: every feature for ${status.trial.days} days, then the Free plan for as long as you like. No card needed. Download and browser connection unlock after that.`
      : 'Start the Free plan, or choose a paid plan or credits. Download and browser connection unlock after that.',
  };
  const isAdmin = session.role === 'ADMIN';
  const trialLicence = status.licences.find((l) => l.kind === 'TRIAL');
  const trialProgress =
    ent.state === 'TRIAL_ACTIVE' && trialLicence?.starts_at && trialLicence?.expires_at
      ? Math.min(100, Math.max(0, ((parseUtc(status.server_time).getTime() - parseUtc(trialLicence.starts_at).getTime()) /
          (parseUtc(trialLicence.expires_at).getTime() - parseUtc(trialLicence.starts_at).getTime())) * 100))
      : null;
  const connected = devices.some((d) => d.status === 'ACTIVE');
  // Grey hero only when access ended or is locked; a new account keeps the blue one
  const heroMuted = !connectedOk && ent.state !== 'NONE';
  const freePlan = plans.find((p) => p.kind === 'FREE');
  const freeProgress = isFree && freeLimit > 0 ? Math.min(100, (freeUsed / freeLimit) * 100) : null;
  const trialPlan = plans.find((p) => p.kind === 'TRIAL');
  const trialUsed = status.licences.some((l) => l.kind === 'TRIAL');
  const needsEmail = !emailVerified && !trialUsed && !status.trial.eligible;
  const freeOk = !!status.free?.eligible;

  type Step = { done: boolean; title: string; detail: string; tab?: NavTab; href?: string; cta?: string };
  const steps: Step[] = [
    { done: true, title: 'Create your account', detail: 'Signed in.' },
    ent.state === 'SUBSCRIPTION_ACTIVE' || ent.state === 'CREDITS_ACTIVE'
      ? { done: true, title: 'Choose a plan', detail: ent.state === 'CREDITS_ACTIVE' ? 'Pay as you go with credits.' : 'Your plan is active.' }
      : isFree
      ? { done: true, title: 'Choose a plan', detail: 'Free plan active. Start the trial or upgrade any time.' }
      : ent.state === 'TRIAL_ACTIVE'
      ? { done: true, title: 'Choose a plan', detail: 'Free trial active.' }
      : { done: connectedOk, title: 'Choose a plan', detail: 'Start free, or choose a paid plan or credits.', href: '#plans', cta: 'See plans' },
    { done: connected, title: 'Download the extension', detail: connectedOk ? 'Chrome or Edge.' : 'Unlocks after you choose a plan.', tab: 'download' as NavTab, cta: 'Download' },
    { done: connected, title: 'Connect your browser', detail: connectedOk ? 'Generate a code and paste it into the extension.' : 'Unlocks after you download the extension.', tab: 'activation' as NavTab, cta: 'Get code' },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div>
        <h1 className="page-title">Account &amp; plan</h1>
        <p className="page-subtitle">{session.organization_name} · {session.email}</p>
      </div>

      {error && <div className="callout" style={{ color: 'var(--color-danger-text)', background: 'var(--color-danger-bg)', border: '1px solid var(--color-danger-border)' }}>{error}</div>}
      {notice && <div className="callout" style={{ color: 'var(--color-success-text)', background: 'var(--color-success-bg)', border: '1px solid var(--color-success-border)' }}>{notice}</div>}

      {/* Plan status */}
      <section className={`plan-hero ${heroMuted ? 'plan-hero-inactive' : ''}`}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <span className={`status-pill ${STATE_CLASS[ent.state]}`} style={{ background: 'rgba(255,255,255,0.92)' }}>
            <span className="status-dot" /> {STATE_LABEL[ent.state]}
          </span>
          <h2 style={{ fontSize: '24px', fontWeight: 700, marginTop: '10px' }}>
            {headline[ent.state] || (active ? PLAN_NAMES[ent.plan_code || ''] || 'Active plan' : 'Access suspended')}
          </h2>
          <p style={{ opacity: 0.9, fontSize: '13.5px', marginTop: '4px' }}>
            {subline[ent.state] || (active
              ? (ent.expires_at ? `Ends ${formatDate(ent.expires_at)} · ${ent.devices_used} of ${ent.device_limit} devices in use` : `No end date · ${ent.devices_used} devices in use`)
                + (credits > 0 ? ` · ${credits.toLocaleString()} credits` : '')
              : 'Contact AgentShield support.')}
          </p>
          {freeProgress !== null && (
            <div className="hero-progress" title={`${freeUsed} of ${freeLimit} free prompt checks used`}><div style={{ width: `${freeProgress}%` }} /></div>
          )}
          {trialProgress !== null && (
            <div className="hero-progress"><div style={{ width: `${trialProgress}%` }} /></div>
          )}
          <div style={{ display: 'flex', gap: '10px', marginTop: '16px', flexWrap: 'wrap' }}>
            {/* One free choice: the trial when it can still be claimed (then Free forever), otherwise the Free plan */}
            {!connectedOk && (status.trial.eligible || freeOk) && (
              <button type="button" className="btn-hero" onClick={startFreeAny} disabled={claiming}>
                <Gift size={16} /> {claiming ? 'Starting...' : 'Start free'}
              </button>
            )}
            {!connectedOk && (status.trial.eligible || freeOk) && (
              <a className="btn-hero-ghost" href="#plans"><CreditCard size={16} /> See paid plans</a>
            )}
            {connectedOk && isFree && status.trial.eligible && (
              <button type="button" className="btn-hero" onClick={claim} disabled={claiming}>
                <Gift size={16} /> {claiming ? 'Starting...' : `Try every feature free for ${status.trial.days} days`}
              </button>
            )}
            {connectedOk && (
              <>
                <button type="button" className="btn-hero" onClick={() => onNavigate('download')}><Download size={16} /> Download extension</button>
                <button type="button" className="btn-hero-ghost" onClick={() => onNavigate('activation')}><KeyRound size={16} /> Get activation code</button>
              </>
            )}
            {needsEmail && (
              <button type="button" className="btn-hero" onClick={resendLink}><Mail size={16} /> Confirm email to unlock the Free plan and trial</button>
            )}
            {(!active || isFree) && !status.trial.eligible && !(!connectedOk && freeOk) && (
              <a className={needsEmail ? 'btn-hero-ghost' : 'btn-hero'} href="#plans"><CreditCard size={16} /> Choose a plan</a>
            )}
          </div>
          {!status.trial.eligible && status.trial.reason && ent.state === 'NONE' && (
            <p style={{ fontSize: '12.5px', marginTop: '10px', opacity: 0.9 }}>{status.trial.reason}</p>
          )}
        </div>
        {active && ent.days_left !== null && ent.days_left !== undefined && (
          <div className="hero-days">
            <span>{ent.days_left}</span>
            <small>day{ent.days_left === 1 ? '' : 's'} left</small>
          </div>
        )}
      </section>

      {/* Setup steps */}
      <section className="glass-panel" style={{ padding: '24px' }}>
        <SectionHeader icon={<ShieldCheck size={18} />} title="Get protected in 4 steps" />
        <div className="steps-grid">
          {steps.map((s, i) => (
            <div key={s.title} className={`step-tile ${s.done ? 'done' : ''}`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {s.done ? <CheckCircle2 size={18} color="var(--color-success)" /> : <Circle size={18} color="var(--text-faint)" />}
                <strong style={{ fontSize: '13px' }}>{i + 1}. {s.title}</strong>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '6px 0 0 26px' }}>{s.detail}</div>
              {!s.done && s.tab && connectedOk && (
                <button type="button" className="link-btn" style={{ margin: '8px 0 0 26px' }} onClick={() => onNavigate(s.tab!)}>{s.cta} →</button>
              )}
              {!s.done && s.href && (
                <a className="link-btn" style={{ margin: '8px 0 0 26px', display: 'inline-block' }} href={s.href}>{s.cta} →</a>
              )}
              {!s.done && s.tab && !connectedOk && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '11.5px', color: 'var(--text-faint)', margin: '8px 0 0 26px' }}>
                  <Lock size={12} /> Locked
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Plans */}
      <section className="glass-panel" style={{ padding: '24px' }} id="plans">
        <SectionHeader icon={<CreditCard size={18} />} title="Plans">
          Every plan includes all protection features. {payConfig?.payments_enabled
            ? 'Pay securely with Razorpay (cards, UPI, net banking). Buying before your plan ends adds the new period after it, so no days are lost.'
            : 'Online payment is not switched on for this server yet; contact AgentShield to activate a plan, and your browsers reconnect automatically.'}
          {payConfig?.test_mode && <strong> Test mode: no real money is taken.</strong>}
        </SectionHeader>
        <div className="plans-grid">
          {/* Individuals: one Free card in two stages, the full trial first, then Free forever (computed by
              the server for confirmed individual accounts). The server decides whether the trial can start. */}
          {freePlan && session.account_type !== 'COMPANY' && (() => {
            const onTrial = ent.state === 'TRIAL_ACTIVE';
            const trialEnd = onTrial && ent.expires_at ? formatDate(ent.expires_at) : null;
            const trialStatus = onTrial ? (trialEnd ? `Active · ends ${trialEnd}` : 'Active')
              : status.trial.eligible ? 'Available'
              : needsEmail ? 'Confirm your email first'
              : trialUsed ? 'Used' : 'Not available';
            const freeStatus = isFree ? (ent.state === 'FREE_PAUSED' ? `Paused until ${resets}` : 'Active')
              : onTrial ? (trialEnd ? `Starts ${trialEnd}` : 'After your trial')
              : needsEmail ? 'Confirm your email first'
              : active ? 'When your plan ends'
              : freeOk ? 'Not started' : 'After your trial';
            const freeChecks = freePlan.check_limit ? `${freePlan.check_limit.toLocaleString()} prompt checks/month` : 'Prompt checks every month';
            const freeBrowsers = `${freePlan.device_limit} browser${freePlan.device_limit === 1 ? '' : 's'}`;
            return (
              <div className={`plan-tile plan-tile-free ${onTrial || isFree ? 'current' : ''}`}>
                <span className="plan-tag plan-tag-free">{onTrial ? 'Current plan · trial' : isFree ? 'Current plan' : 'Free forever'}</span>
                <div style={{ fontSize: '15px', fontWeight: 700 }}>Free</div>
                <div className="plan-price">Free<small> / forever</small></div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No card needed · start with the {status.trial.days}-day full trial or go straight to Free forever</div>
                <ol className="free-stages">
                  <li className={onTrial ? 'now' : trialUsed || isFree ? 'past' : ''}>
                    <strong>1. Full trial · {status.trial.days} days</strong>
                    <span>All features{trialPlan ? ` · up to ${trialPlan.device_limit} browsers` : ''}{trialPlan?.check_limit ? ` · ${trialPlan.check_limit.toLocaleString()} prompt checks/month` : ''} · once per person</span>
                    <em>{trialStatus}</em>
                  </li>
                  <li className={isFree ? 'now' : ''}>
                    <strong>2. Free forever</strong>
                    <span>{freeChecks} · {freeBrowsers} · website controls and category blocking</span>
                    <em>{freeStatus}</em>
                  </li>
                </ol>
                {!connectedOk && (status.trial.eligible || freeOk) ? (
                  <button type="button" className="btn-primary" disabled={claiming} style={{ width: '100%', justifyContent: 'center' }} onClick={startFreeAny}>
                    <Gift size={15} /> {claiming ? 'Starting...' : 'Start free'}
                  </button>
                ) : isFree && status.trial.eligible ? (
                  <button type="button" className="btn-primary" disabled={claiming} style={{ width: '100%', justifyContent: 'center' }} onClick={claim}>
                    <Gift size={15} /> {claiming ? 'Starting...' : `Try every feature for ${status.trial.days} days`}
                  </button>
                ) : needsEmail ? (
                  <>
                    <button type="button" className="btn-secondary" disabled style={{ width: '100%', justifyContent: 'center' }}>Confirm your email first</button>
                    <button type="button" className="link-btn" style={{ alignSelf: 'center', fontSize: '12px' }} onClick={resendLink}>Send a new confirmation link</button>
                  </>
                ) : (
                  <button type="button" className="btn-secondary" disabled style={{ width: '100%', justifyContent: 'center' }}>
                    {onTrial ? 'Trial active' : isFree ? freeStatus : `Free plan: ${freeStatus.toLowerCase()}`}
                  </button>
                )}
              </div>
            );
          })()}
          {/* Company workspaces: the trial card on its own (no Free plan) */}
          {!(freePlan && session.account_type !== 'COMPANY') && (
          <div className={`plan-tile plan-tile-free ${ent.state === 'TRIAL_ACTIVE' ? 'current' : ''}`}>
            <span className="plan-tag plan-tag-free">{ent.state === 'TRIAL_ACTIVE' ? 'Current plan' : 'Free'}</span>
            <div style={{ fontSize: '15px', fontWeight: 700 }}>{trialPlan?.name || 'Free trial'}</div>
            <div className="plan-price">Free<small> / {status.trial.days} days</small></div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              No card needed · once per {session.account_type === 'COMPANY' ? 'company' : 'person'}{trialPlan ? ` · up to ${trialPlan.device_limit} browsers` : ''}
              {trialPlan?.check_limit ? ` · ${trialPlan.check_limit.toLocaleString()} prompt checks/month` : ''}
            </div>
            <ul className="plan-features">
              {(trialPlan?.features.length ? trialPlan.features : ['All protection features', 'Personal dashboard and alerts']).map((f) => (
                <li key={f}><CheckCircle2 size={14} color="var(--color-success)" /> {f}</li>
              ))}
            </ul>
            {status.trial.eligible ? (
              <button type="button" className="btn-primary" disabled={claiming} style={{ width: '100%', justifyContent: 'center' }} onClick={claim}>
                <Gift size={15} /> {claiming ? 'Starting...' : 'Start free trial'}
              </button>
            ) : needsEmail ? (
              <>
                <button type="button" className="btn-secondary" disabled style={{ width: '100%', justifyContent: 'center' }}>Confirm your email first</button>
                <button type="button" className="link-btn" style={{ alignSelf: 'center', fontSize: '12px' }} onClick={resendLink}>Send a new confirmation link</button>
              </>
            ) : (
              <button type="button" className="btn-secondary" disabled style={{ width: '100%', justifyContent: 'center' }}>
                {ent.state === 'TRIAL_ACTIVE' ? 'Active' : trialUsed ? 'Trial already used' : 'Not available'}
              </button>
            )}
          </div>
          )}
          {plans.filter((p) => p.kind === 'PAID' || p.kind === 'CREDITS').map((p) => {
            const isPack = p.kind === 'CREDITS';
            const current = ent.state === 'SUBSCRIPTION_ACTIVE' && ent.plan_code === p.code;
            const canBuy = isAdmin && !!payConfig?.payments_enabled && p.purchasable && !!p.price_minor;
            const subscribed = p.billing === 'recurring' && !!subscription && ['active', 'authenticated'].includes(subscription.status) && !subscription.cancel_at_period_end;
            const label = !isAdmin ? 'Ask your administrator'
              : subscribed ? 'Subscribed'
              : !p.price_minor || !p.purchasable ? 'Not available yet'
              : !payConfig?.payments_enabled ? 'Contact AgentShield'
              : paying === p.code ? 'Opening payment...'
              : isPack ? 'Buy credits'
              : p.billing === 'recurring' ? 'Subscribe' : current || active ? 'Buy / extend' : 'Buy';
            return (
              <div key={p.code} className={`plan-tile ${current ? 'current' : ''} ${isPack ? 'plan-tile-payg' : ''}`}>
                {current && <span className="plan-tag">Current plan</span>}
                {isPack && <span className="plan-tag plan-tag-payg">Pay as you go</span>}
                <div style={{ fontSize: '15px', fontWeight: 700 }}>{p.name}</div>
                <div className="plan-price">
                  {p.price_minor ? formatMoney(p.price_minor, p.currency) : 'Price coming soon'}
                  {p.price_minor ? <small> / {isPack ? `${(p.credits || 0).toLocaleString()} prompt checks` : planDuration(p)}</small> : null}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  {isPack
                    ? `1 credit = 1 prompt check · credits never expire${credits ? ` · you have ${credits.toLocaleString()}` : ''}`
                    : `${p.billing === 'recurring' ? 'Renews automatically, cancel any time' : `One payment for ${planDuration(p)}`} · up to ${p.device_limit} browsers${p.check_limit ? ` · ${p.check_limit.toLocaleString()} prompt checks/month` : ''}`}
                </div>
                <ul className="plan-features">
                  {p.features.map((f) => <li key={f}><CheckCircle2 size={14} color="var(--color-success)" /> {f}</li>)}
                </ul>
                <button
                  type="button"
                  className={canBuy && !subscribed ? 'btn-primary' : 'btn-secondary'}
                  disabled={!canBuy || subscribed || paying !== null}
                  style={{ width: '100%', justifyContent: 'center' }}
                  onClick={() => buy(p)}
                >
                  {label}
                </button>
              </div>
            );
          })}
        </div>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '12px' }}>
          Cancellation: a recurring plan can be cancelled at any time and stays active until the end of the paid period; one-time plans simply end on their end date. Nothing renews without a confirmed payment.
        </p>
      </section>

      {/* Invite friends */}
      {referrals?.enabled && (
        <section className="glass-panel" style={{ padding: '24px' }}>
          <SectionHeader icon={<Users size={18} />} title="Invite friends">
            When a friend signs up with your link and confirms their email, you both get {(referrals.bonus_checks ?? 0).toLocaleString()} bonus
            prompt checks (rewarded for up to {referrals.max_rewarded} friends).
          </SectionHeader>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="input" readOnly value={referrals.link || ''} aria-label="Your invite link" style={{ flex: 1, minWidth: 240 }} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn-primary" onClick={copyInvite}><Copy size={15} /> {copied ? 'Copied' : 'Copy link'}</button>
          </div>
          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', fontSize: '13px', marginTop: '14px' }}>
            <div><div className="cell-sub">Invited</div><strong>{referrals.invited ?? 0}</strong></div>
            <div><div className="cell-sub">Waiting for email confirmation</div><strong>{referrals.pending ?? 0}</strong></div>
            <div><div className="cell-sub">Rewarded</div><strong>{referrals.rewarded ?? 0} of {referrals.max_rewarded}</strong></div>
            <div><div className="cell-sub">Bonus earned</div><strong>{(referrals.bonus_earned ?? 0).toLocaleString()} prompt checks</strong></div>
          </div>
        </section>
      )}

      {/* Billing history */}
      {(orders.length > 0 || subscription) && (
        <section className="glass-panel" style={{ padding: '24px' }}>
          <SectionHeader icon={<Receipt size={18} />} title="Billing">
            {subscription && (
              <>
                Monthly subscription: <strong>{subscription.cancel_at_period_end ? 'cancelled, no further renewals' : subscription.status}</strong>
                {subscription.current_end && ` · current period ends ${formatDate(subscription.current_end)}`}
              </>
            )}
          </SectionHeader>
          {subscription && !subscription.cancel_at_period_end && ['created', 'authenticated', 'active', 'pending'].includes(subscription.status) && isAdmin && (
            <button type="button" className="btn-ghost-danger" style={{ marginBottom: '12px' }} onClick={cancelSubscription}>Cancel automatic renewal</button>
          )}
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Date</th><th>Plan</th><th>Amount</th><th>Status</th><th>Receipt</th></tr></thead>
              <tbody>
                {orders.length === 0 && <tr><td colSpan={5} className="empty-cell">No payments yet.</td></tr>}
                {orders.flatMap((o) =>
                  (o.payments.length ? o.payments : [null]).map((pay, i) => {
                    const st = pay ? (pay.status === 'captured' ? 'paid' : pay.status) : o.status === 'created' ? 'not completed' : o.status;
                    const cls = st === 'paid' ? 'status-active' : ['failed', 'refunded', 'disputed'].includes(st) ? 'status-expired' : 'status-pending';
                    return (
                    <tr key={`${o.id}-${i}`}>
                      <td>{formatDate(pay?.created_at || o.created_at)}</td>
                      <td style={{ fontWeight: 600, color: 'var(--text-main)' }}>{PLAN_NAMES[o.plan_code] || o.plan_code}{o.kind === 'subscription' ? ' (monthly)' : ''}</td>
                      <td>{formatMoney(pay?.amount_minor ?? o.amount_minor, pay?.currency || o.currency)}{pay?.refunded_minor ? <div className="cell-sub">Refunded {formatMoney(pay.refunded_minor, pay.currency)}</div> : null}</td>
                      <td>
                        <span className={`status-pill ${cls}`}><span className="status-dot" /> {st.replace('_', ' ')}</span>
                        {!pay && o.failure_reason && <div className="cell-sub">{o.failure_reason}</div>}
                      </td>
                      <td>{pay?.receipt_number ? <button type="button" className="link-btn" onClick={() => openReceipt(pay.id)}>{pay.receipt_number}</button> : '—'}</td>
                    </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '20px' }}>
        {/* Licence history */}
        <section className="glass-panel" style={{ padding: '24px' }}>
          <SectionHeader icon={<Monitor size={18} />} title="Licence history" />
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Plan</th><th>From</th><th>Until</th><th>Status</th></tr></thead>
              <tbody>
                {status.licences.length === 0 && <tr><td colSpan={4} className="empty-cell">No licences yet.</td></tr>}
                {status.licences.map((l) => (
                  <tr key={l.id}>
                    <td style={{ fontWeight: 600, color: 'var(--text-main)' }}>{PLAN_NAMES[l.plan_code] || l.plan_code}</td>
                    <td>{formatDate(l.starts_at)}</td>
                    <td>{l.expires_at ? formatDate(l.expires_at) : 'No end'}</td>
                    <td><span className={`status-pill ${l.status === 'ACTIVE' ? 'status-active' : l.status === 'SCHEDULED' ? 'status-pending' : 'status-expired'}`}><span className="status-dot" /> {l.status.toLowerCase()}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Notices */}
        <section className="glass-panel" style={{ padding: '24px' }}>
          <SectionHeader icon={<Bell size={18} />} title="Notices" />
          {status.notifications.length === 0 ? (
            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No notices. We'll remind you 7, 3 and 1 days before your plan ends.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {status.notifications.map((n) => (
                <div key={n.id} className="list-row" style={{ alignItems: 'flex-start', opacity: n.read ? 0.65 : 1 }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-main)' }}>{n.title}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{n.body}</div>
                  </div>
                  {!n.read && (
                    <button type="button" className="link-btn" onClick={async () => { await api.markNotificationRead(n.id); load(); }}>Mark read</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Account */}
      <section className="glass-panel" style={{ padding: '24px' }}>
        <SectionHeader icon={<UserCircle2 size={18} />} title="Your account" />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '24px', fontSize: '13px', alignItems: 'center' }}>
          <div><div className="cell-sub">Email</div><strong>{session.email}</strong></div>
          <div><div className="cell-sub">Company</div><strong>{session.organization_name}</strong></div>
          <div><div className="cell-sub">Role</div><strong style={{ textTransform: 'capitalize' }}>{session.role.toLowerCase()}</strong></div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '10px' }}>
            {isAdmin && <button type="button" className="btn-secondary" onClick={() => onNavigate('deployment')}>Change password</button>}
            <button type="button" className="btn-ghost-danger" onClick={signOutEverywhere}><LogOut size={14} /> Sign out everywhere</button>
          </div>
        </div>
      </section>
    </motion.div>
  );
};
