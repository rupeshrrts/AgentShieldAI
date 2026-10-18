import React from 'react';
import { CheckCircle2, Lock, XCircle } from 'lucide-react';

/**
 * Honest statement of what AgentShield enforces and what it does not.
 * Keep in sync with SECURITY_ARCHITECTURE.md.
 */

const covered: Array<[string, string]> = [
  ['Prompts on supported AI sites', 'ChatGPT, Claude, Gemini, Copilot, Perplexity, DeepSeek, Mistral, Poe, Meta AI and Grok: Enter, Ctrl/Cmd+Enter, the send button and form submits are checked before sending.'],
  ['File uploads on those sites', 'File picker, drag-and-drop and pasted files. Text files (code, CSV, JSON, logs, .env...) up to 2 MB are scanned with the same rules.'],
  ['Website blocking', 'Blocked sites, and optionally every unapproved AI tool, are stopped at the network level in the browser before the page loads.'],
  ['Detection', 'API keys, tokens, passwords, private keys, emails, phone numbers, card numbers (Luhn), Aadhaar (Verhoeff), PAN, and your confidential keywords.'],
  ['Employee controls', 'Warn, restrict (warnings become blocks) or suspend (all prompts blocked) individual employees.'],
  ['Offline operation', 'Rules are cached in the browser and keep being enforced if the server is unreachable; events are queued and sent later.'],
];

const notCovered: Array<[string, string]> = [
  ['Other browsers and apps', 'Firefox, Safari, desktop AI apps (ChatGPT/Claude desktop), mobile apps, and scripts or API calls are not covered. Use network/DNS filtering or allow only managed Chrome/Edge.'],
  ['Disabling the extension', 'Employees can remove an extension they installed themselves (AI sites are then unprotected, and the browser stops reporting). Only a force-install through Group Policy, Intune or Google Admin prevents this.'],
  ['Editing the extension locally', 'A user with developer mode can modify a self-installed extension\'s code and skip the activation screen. The server still refuses to sync rules or accept reports from a browser without a valid device session, so it never appears as protected. Force-install the extension to prevent this.'],
  ['Content of PDF, Office and image files', 'Uploads of these files are subject to the File upload rule, but their content is not read.'],
  ['Meaning of text', 'Detection is pattern-based. Rephrased or obfuscated data (e.g. a key split across lines, a screenshot of a password) can be missed, and unusual text can be flagged by mistake.'],
  ['Site changes', 'If an AI site changes its page layout, prompt checks may stop working on that site until AgentShield is updated. The in-page badge then shows "Not Protected".'],
  ['Verified identity', 'The employee ID comes from IT configuration or the browser profile email; it is not verified by single sign-on.'],
  ['Developer tools', 'A technical user can bypass in-page checks with browser developer tools. Disable them by policy (DeveloperToolsAvailability) on managed devices.'],
];

const guarantees: Array<[string, string]> = [
  ['Local inspection', 'Prompt text and file contents are checked inside the employee\'s browser. Nothing is sent to AgentShield to decide.'],
  ['Masked before leaving the browser', 'Passwords, keys, card and Aadhaar numbers are masked in every event; the server masks them again before storing.'],
  ['Privacy by default', 'Text of allowed prompts is not stored unless you turn it on. Events are deleted after the retention period.'],
  ['Per-user activation', 'Every browser is activated by a signed-in account with a single-use code and bound to a key that never leaves it. Copying the extension, its files or its storage grants nothing, and AI sites stay blocked until activation.'],
  ['Least-privilege devices', 'An activated browser holds only a 15-minute session that can read rules and submit events, never sign in to the dashboard or change settings. Revoking it takes effect at its next request.'],
  ['Accountability', 'Every admin change and sign-in attempt is recorded in the Admin Audit Log with before/after values.'],
  ['Tenant isolation', 'Every query is filtered by the organization of the signed-in admin or enrolled browser.'],
];

const List: React.FC<{ items: Array<[string, string]>; icon: React.ReactNode }> = ({ items, icon }) => (
  <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' }}>
    {items.map(([title, text]) => (
      <li key={title} style={{ display: 'flex', gap: '8px' }}>
        <span style={{ flexShrink: 0, marginTop: '1px' }}>{icon}</span>
        <span><strong style={{ color: 'var(--text-main)' }}>{title}.</strong> <span style={{ color: 'var(--text-muted)' }}>{text}</span></span>
      </li>
    ))}
  </ul>
);

export const Limitations: React.FC = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
    <div>
      <h2 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-main)' }}>Coverage & Limits</h2>
      <p style={{ fontSize: '13px', color: 'var(--text-muted)', maxWidth: '780px' }}>
        AgentShield is a browser extension with a central policy server. It is not an endpoint agent, a network proxy or a
        complete DLP suite. This page states exactly what it enforces.
      </p>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '20px' }}>
      <div className="glass-panel" style={{ padding: '20px', borderLeft: '4px solid var(--color-success)' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--color-success-text)', marginBottom: '14px' }}>Enforced</h3>
        <List items={covered} icon={<CheckCircle2 size={16} color="var(--color-success)" />} />
      </div>
      <div className="glass-panel" style={{ padding: '20px', borderLeft: '4px solid var(--color-danger)' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--color-danger-text)', marginBottom: '14px' }}>Not covered (needs other controls)</h3>
        <List items={notCovered} icon={<XCircle size={16} color="var(--color-danger)" />} />
      </div>
    </div>

    <div className="glass-panel" style={{ padding: '20px' }}>
      <h3 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-main)', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Lock size={18} color="var(--color-primary)" /> Data handling
      </h3>
      <List items={guarantees} icon={<CheckCircle2 size={16} color="var(--color-primary)" />} />
      <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '12px' }}>
        Extension permissions: it can read pages on all websites, which is required to block websites and inspect AI sites. Prompt
        checks run only on the supported AI sites listed above. Full details are in DATA_HANDLING.md and SECURITY_ARCHITECTURE.md.
      </p>
    </div>
  </div>
);
