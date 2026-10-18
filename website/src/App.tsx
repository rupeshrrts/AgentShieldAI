import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRight, BadgeCheck, Building2, ChevronDown, Chrome, Eye, FileLock2, Gauge, Globe2, KeyRound, Lock, Menu,
  ShieldCheck, Sparkles, UserRound, X, Zap,
} from 'lucide-react';
import { BrowserMock, HeroShield } from './Art';

// Customer portal (sign-up and sign-in). Set VITE_PORTAL_URL when deploying.
const PORTAL = ((import.meta.env.VITE_PORTAL_URL as string | undefined) || 'http://localhost:5173').replace(/\/$/, '');
const SIGNUP_URL = `${PORTAL}/#signup`;
const LOGIN_URL = `${PORTAL}/#signin`;
// Internal admin console for AgentShieldAI staff (own app, own accounts with MFA). Only a link; a
// production build shows it only when VITE_ADMIN_CONSOLE_URL is set.
const ADMIN_URL: string | null =
  (import.meta.env.VITE_ADMIN_CONSOLE_URL as string | undefined) || (import.meta.env.DEV ? 'http://localhost:5175' : null);

// "Log in" button; with an admin console address it opens a small menu: customer portal or staff console.
const LoginMenu: React.FC = () => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!ADMIN_URL) return <a className="btn btn-ghost" href={LOGIN_URL}>Log in</a>;
  return (
    <div className="login-menu" ref={ref}>
      <button type="button" className="btn btn-ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        Log in <ChevronDown size={16} className={`chev ${open ? 'up' : ''}`} />
      </button>
      {open && (
        <div className="login-pop" role="menu" aria-label="Log in">
          <span className="lp-head">Log in to AgentShieldAI</span>
          <a role="menuitem" href={LOGIN_URL}>
            <span className="lp-icon"><UserRound size={18} /></span>
            <span className="lp-text"><strong>Log in as user</strong><small>Your dashboard and alerts</small></span>
            <ArrowRight size={16} className="lp-go" />
          </a>
          <a role="menuitem" href={ADMIN_URL}>
            <span className="lp-icon lp-admin"><ShieldCheck size={18} /></span>
            <span className="lp-text"><strong>Log in as admin</strong><small>AgentShieldAI staff · MFA required</small></span>
            <ArrowRight size={16} className="lp-go" />
          </a>
          <span className="lp-foot">New here? <a href={SIGNUP_URL}>Create a free account</a></span>
        </div>
      )}
    </div>
  );
};

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: (i = 0) => ({ opacity: 1, y: 0, transition: { duration: 0.55, delay: i * 0.08, ease: [0.22, 1, 0.36, 1] } }),
};

const FEATURES = [
  { icon: <KeyRound size={22} />, title: 'Stops secrets and keys', text: 'API keys, passwords, tokens and private keys are caught before they reach ChatGPT, Claude, Gemini or Copilot.' },
  { icon: <FileLock2 size={22} />, title: 'Protects personal data', text: 'Emails, phone numbers, card and ID numbers can be warned about or redacted automatically.' },
  { icon: <Globe2 size={22} />, title: 'Blocks risky websites', text: 'Keep files away from unapproved converters and paste sites with simple website controls.' },
  { icon: <Eye size={22} />, title: 'Clear security alerts', text: 'See what was blocked, warned or redacted, on which site, and why — in your own dashboard.' },
  { icon: <Lock size={22} />, title: 'Private by design', text: 'Checks run inside your browser. Prompt text is masked before anything is stored.' },
  { icon: <Zap size={22} />, title: 'Works in seconds', text: 'Install the extension, paste a one-time code, done. No proxy, no VPN, no slowdown.' },
];

const STEPS = [
  { n: '1', title: 'Create your account', text: 'Sign up with your email and confirm it.' },
  { n: '2', title: 'Start free for 30 days', text: 'Or pick monthly, 6-month, annual or pay as you go.' },
  { n: '3', title: 'Install AgentShield', text: 'On Windows, one setup adds it to Chrome, Edge and Brave. Or add it to one browser.' },
  { n: '4', title: 'Connect once', text: 'Click "Connect this PC" in your dashboard. Every browser connects by itself.' },
];

export const App: React.FC = () => {
  const [menu, setMenu] = useState(false);

  return (
    <div className="page">
      {/* Navigation */}
      <header className="nav">
        <div className="container nav-inner">
          <a href="#top" className="brand"><img src="/logo.png" alt="" width={34} height={34} /> <span className="brand-name">AgentShield<span>AI</span></span></a>
          <nav className={`nav-links ${menu ? 'open' : ''}`} aria-label="Main">
            <a href="#features" onClick={() => setMenu(false)}>Features</a>
            <a href="#how" onClick={() => setMenu(false)}>How it works</a>
            <a href="#plans" onClick={() => setMenu(false)}>Plans</a>
            <a href="#security" onClick={() => setMenu(false)}>Security</a>
            <div className="nav-cta-mobile">
              <a className="btn btn-ghost" href={LOGIN_URL}>Log in</a>
              <a className="btn btn-primary" href={SIGNUP_URL}>Sign up free</a>
            </div>
            {ADMIN_URL && <a className="nav-admin-mobile" href={ADMIN_URL}><ShieldCheck size={15} /> Log in as admin</a>}
          </nav>
          <div className="nav-cta">
            <LoginMenu />
            <a className="btn btn-primary" href={SIGNUP_URL}>Sign up free <ArrowRight size={16} /></a>
          </div>
          <button className="menu-btn" aria-label={menu ? 'Close menu' : 'Open menu'} onClick={() => setMenu(!menu)}>
            {menu ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </header>

      {/* Hero */}
      <section className="hero" id="top">
        <div className="hero-bg" aria-hidden="true" />
        <div className="container hero-inner">
          <motion.div initial="hidden" animate="show" className="hero-copy">
            <motion.span variants={fadeUp} custom={0} className="eyebrow"><Sparkles size={14} /> AI browser security</motion.span>
            <motion.h1 variants={fadeUp} custom={1}>Use AI tools freely.<br /><span className="grad">Never leak a secret.</span></motion.h1>
            <motion.p variants={fadeUp} custom={2} className="lead">
              AgentShieldAI sits in your browser and checks every prompt you send to ChatGPT, Claude, Gemini and Copilot —
              stopping passwords, API keys and personal data before they leave your screen.
            </motion.p>
            <motion.div variants={fadeUp} custom={3} className="hero-actions">
              <a className="btn btn-primary btn-lg" href={SIGNUP_URL}>Start free 30-day trial <ArrowRight size={18} /></a>
              <a className="btn btn-outline btn-lg" href={LOGIN_URL}>Log in</a>
            </motion.div>
            <motion.ul variants={fadeUp} custom={4} className="hero-points">
              <li><BadgeCheck size={16} /> No card needed for the trial</li>
              <li><BadgeCheck size={16} /> Chrome &amp; Edge</li>
              <li><BadgeCheck size={16} /> Set up in minutes</li>
            </motion.ul>
          </motion.div>
          <motion.div initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.8, ease: 'easeOut' }}>
            <HeroShield />
          </motion.div>
        </div>
        <div className="container works-with">
          <span>Protects your prompts on</span>
          <strong>ChatGPT</strong><strong>Claude</strong><strong>Gemini</strong><strong>Microsoft Copilot</strong><strong>Perplexity</strong>
        </div>
      </section>

      {/* Features */}
      <section className="section" id="features">
        <div className="container">
          <motion.div className="section-head" initial="hidden" whileInView="show" viewport={{ once: true, margin: '-80px' }}>
            <motion.span variants={fadeUp} className="eyebrow eyebrow-dark"><ShieldCheck size={14} /> What it does</motion.span>
            <motion.h2 variants={fadeUp} custom={1}>Security that works where AI happens</motion.h2>
            <motion.p variants={fadeUp} custom={2}>Every prompt is checked against clear protection rules before it is sent. You stay productive; your data stays yours.</motion.p>
          </motion.div>
          <div className="feature-grid">
            {FEATURES.map((f, i) => (
              <motion.article key={f.title} className="feature-card" variants={fadeUp} custom={i} initial="hidden" whileInView="show"
                viewport={{ once: true, margin: '-60px' }} whileHover={{ y: -6 }}>
                <div className="feature-icon">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </motion.article>
            ))}
          </div>
        </div>
      </section>

      {/* Showcase */}
      <section className="section section-tint">
        <div className="container showcase">
          <motion.div initial="hidden" whileInView="show" viewport={{ once: true, margin: '-80px' }}>
            <motion.span variants={fadeUp} className="eyebrow eyebrow-dark"><Eye size={14} /> In action</motion.span>
            <motion.h2 variants={fadeUp} custom={1}>Caught in the moment, not after the leak</motion.h2>
            <motion.p variants={fadeUp} custom={2}>
              When a prompt contains something sensitive, AgentShieldAI explains what it found and lets you fix it — or
              redacts it for you. Every decision appears in your security alerts.
            </motion.p>
            <motion.ul variants={fadeUp} custom={3} className="check-list">
              <li><BadgeCheck size={18} /> Block, warn or redact — you choose per rule</li>
              <li><BadgeCheck size={18} /> Works on the AI sites you already use</li>
              <li><BadgeCheck size={18} /> Usage and alerts in one dashboard</li>
            </motion.ul>
          </motion.div>
          <motion.div initial={{ opacity: 0, x: 30 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }} transition={{ duration: 0.6 }}>
            <BrowserMock />
          </motion.div>
        </div>
      </section>

      {/* How it works */}
      <section className="section" id="how">
        <div className="container">
          <motion.div className="section-head" initial="hidden" whileInView="show" viewport={{ once: true, margin: '-80px' }}>
            <motion.span variants={fadeUp} className="eyebrow eyebrow-dark"><Chrome size={14} /> How it works</motion.span>
            <motion.h2 variants={fadeUp} custom={1}>Protected in four simple steps</motion.h2>
          </motion.div>
          <div className="steps">
            {STEPS.map((s, i) => (
              <motion.div key={s.n} className="step" variants={fadeUp} custom={i} initial="hidden" whileInView="show" viewport={{ once: true }}>
                <div className="step-num">{s.n}</div>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </motion.div>
            ))}
          </div>
          <div className="center"><a className="btn btn-primary btn-lg" href={SIGNUP_URL}>Create your free account <ArrowRight size={18} /></a></div>
        </div>
      </section>

      {/* Plans */}
      <section className="section section-tint" id="plans">
        <div className="container">
          <motion.div className="section-head" initial="hidden" whileInView="show" viewport={{ once: true, margin: '-80px' }}>
            <motion.span variants={fadeUp} className="eyebrow eyebrow-dark"><Gauge size={14} /> Plans</motion.span>
            <motion.h2 variants={fadeUp} custom={1}>Start free. Pay your way.</motion.h2>
            <motion.p variants={fadeUp} custom={2}>Current prices are shown in your dashboard after you sign up.</motion.p>
          </motion.div>
          <div className="plan-grid">
            <motion.div className="plan-card plan-featured" variants={fadeUp} initial="hidden" whileInView="show" viewport={{ once: true }} whileHover={{ y: -6 }}>
              <div className="plan-top"><UserRound size={22} /><span className="badge badge-green">Available now</span></div>
              <h3>Individual</h3>
              <p className="plan-sub">For you, on your own browsers.</p>
              <ul>
                <li><BadgeCheck size={16} /> Free 30-day trial</li>
                <li><BadgeCheck size={16} /> Monthly, 6-month or annual plans</li>
                <li><BadgeCheck size={16} /> Or pay as you go with credits</li>
                <li><BadgeCheck size={16} /> Personal dashboard, alerts &amp; API access</li>
              </ul>
              <a className="btn btn-primary btn-block" href={SIGNUP_URL}>Sign up free <ArrowRight size={16} /></a>
            </motion.div>
            <motion.div className="plan-card plan-soon" variants={fadeUp} custom={1} initial="hidden" whileInView="show" viewport={{ once: true }}>
              <div className="plan-top"><Building2 size={22} /><span className="badge badge-purple">Coming soon</span></div>
              <h3>Company</h3>
              <p className="plan-sub">For teams and organisations.</p>
              <ul>
                <li><BadgeCheck size={16} /> Employee management &amp; seats</li>
                <li><BadgeCheck size={16} /> Central billing and licensing</li>
                <li><BadgeCheck size={16} /> Company-wide rules and analytics</li>
              </ul>
              <span className="btn btn-disabled btn-block" aria-disabled="true">Coming soon</span>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Security */}
      <section className="section security" id="security">
        <div className="container security-inner">
          <motion.div initial="hidden" whileInView="show" viewport={{ once: true, margin: '-80px' }}>
            <motion.span variants={fadeUp} className="eyebrow"><Lock size={14} /> Built for trust</motion.span>
            <motion.h2 variants={fadeUp} custom={1}>Security you can explain to anyone</motion.h2>
            <motion.p variants={fadeUp} custom={2}>We designed AgentShieldAI so that protecting your data never means handing it over.</motion.p>
          </motion.div>
          <div className="trust-grid">
            {[
              ['Checks in your browser', 'Prompts are inspected locally by the extension.'],
              ['Secrets are masked', 'Keys and passwords are masked before anything is stored.'],
              ['Each browser is verified', 'A one-time code and a key that never leaves the browser.'],
              ['Locked when access ends', 'The server decides access on every request.'],
            ].map(([t, d], i) => (
              <motion.div key={t} className="trust-card" variants={fadeUp} custom={i} initial="hidden" whileInView="show" viewport={{ once: true }}>
                <ShieldCheck size={20} />
                <div><strong>{t}</strong><p>{d}</p></div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="section">
        <motion.div className="container cta" initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.6 }}>
          <h2>Ready to use AI without the worry?</h2>
          <p>Create your account in a minute and start your free 30-day trial.</p>
          <div className="hero-actions center">
            <a className="btn btn-light btn-lg" href={SIGNUP_URL}>Sign up free <ArrowRight size={18} /></a>
            <a className="btn btn-outline-light btn-lg" href={LOGIN_URL}>Log in</a>
          </div>
        </motion.div>
      </section>

      <footer className="footer">
        <div className="container footer-inner">
          <a href="#top" className="brand brand-dark"><img src="/logo.png" alt="" width={28} height={28} /> <span className="brand-name">AgentShield<span>AI</span></span></a>
          <nav aria-label="Footer">
            <a href="#features">Features</a><a href="#how">How it works</a><a href="#plans">Plans</a>
            <a href={LOGIN_URL}>Log in</a><a href={SIGNUP_URL}>Sign up</a>
            {ADMIN_URL && <a href={ADMIN_URL}>Admin log in</a>}
          </nav>
          <span className="copy">© {new Date().getFullYear()} AgentShieldAI</span>
        </div>
      </footer>
    </div>
  );
};
