import React, { useEffect, useState } from 'react';
import { CheckCircle2, Circle, Copy, PlayCircle, RefreshCw, XCircle } from 'lucide-react';
import { api } from '../services/api';
import { NavTab } from '../components/Sidebar';
import { SecurityEvent } from '../types';

/**
 * Guided demo for buyers and reviewers. Every check queries real events recorded since
 * the demo started; nothing is simulated. Uses synthetic test data only.
 */

interface Step {
  id: string;
  title: string;
  instructions: string;
  testData?: string;
  expected: string;
  check?: (events: SecurityEvent[], ctx: { onlineBrowsers: number }) => { pass: boolean; detail: string };
  manual?: boolean;
}

const SAMPLE_KEY = 'sk-demo-ABCDEF1234567890XYZ';

const latest = (events: SecurityEvent[], pred: (e: SecurityEvent) => boolean) => events.find(pred);

const STEPS: Step[] = [
  {
    id: 'enroll',
    title: '1. A browser is enrolled and online',
    instructions: 'Install the extension, open its popup, sign in, paste an activation code from My activation, and click Connect and verify.',
    expected: 'The browser appears under Protected Browsers as Online.',
    check: (_e, ctx) => ({ pass: ctx.onlineBrowsers > 0, detail: `${ctx.onlineBrowsers} browser(s) online` }),
  },
  {
    id: 'block-secret',
    title: '2. A credential is blocked',
    instructions: 'Open chatgpt.com (or the local test bench) and try to send this prompt:',
    testData: `Debug this config: api_key = ${SAMPLE_KEY}`,
    expected: 'A red "Blocked by your organization" dialog appears and the prompt is not sent.',
    check: (events) => {
      const e = latest(events, (x) => x.rule_id === 'secret.api_key_like' && x.action === 'BLOCK' && !x.outcome.startsWith('file'));
      return { pass: Boolean(e), detail: e ? `Blocked for ${e.user_id} on ${e.site}` : 'No blocked credential event yet' };
    },
  },
  {
    id: 'masking',
    title: '3. The secret is not exposed in the logs',
    instructions: 'Nothing to do: this checks the stored event from step 2.',
    expected: 'The stored event contains the decision without any prompt text.',
    check: (events) => {
      const e = latest(events, (x) => x.rule_id === 'secret.api_key_like');
      if (!e) return { pass: false, detail: 'Run step 2 first' };
      const hasText = Boolean(e.prompt_preview || e.prompt);
      return { pass: !hasText, detail: hasText ? 'The event includes prompt text' : 'Only decision metadata recorded' };
    },
  },
  {
    id: 'warn-email',
    title: '4. Personal data triggers a warning',
    instructions: 'Send this prompt and click "Send anyway" in the dialog:',
    testData: 'Draft a reply to priya.sharma@example.com about her refund',
    expected: 'An amber warning asks for confirmation and records your decision.',
    check: (events) => {
      const e = latest(events, (x) => x.rule_id === 'pii.email' && x.action === 'WARN');
      return { pass: Boolean(e), detail: e ? e.outcome.replace(/_/g, ' ') : 'No email warning yet' };
    },
  },
  {
    id: 'redact',
    title: '5. Confidential keywords are masked',
    instructions: 'Send a prompt containing one of your keywords (Deployment & Settings > Confidential keywords), for example:',
    testData: 'Summarise the launch plan for PROJECT-ALPHA-CONFIDENTIAL',
    expected: 'A preview shows the keyword replaced with [REDACTED:RESTRICTED]; "Mask and send" sends the masked text.',
    check: (events) => {
      const e = latest(events, (x) => x.rule_id === 'restricted.keyword' && x.action === 'REDACT');
      return { pass: Boolean(e), detail: e ? 'Redaction recorded' : 'No redaction yet' };
    },
  },
  {
    id: 'site',
    title: '6. A risky website is blocked',
    instructions: 'Open this address in the same browser:',
    testData: 'https://pastebin.com',
    expected: 'The page never loads; the AgentShield block page appears instead.',
    check: (events) => {
      const e = latest(events, (x) => x.rule_id.startsWith('dlp.'));
      return { pass: Boolean(e), detail: e ? `${e.site} blocked (${e.rule_id})` : 'No blocked-website event yet' };
    },
  },
  {
    id: 'file',
    title: '7. A file upload is checked',
    instructions: 'Save this line in a text file (e.g. demo.txt), then attach it in ChatGPT:',
    testData: 'db password: Demo-Only-Passw0rd',
    expected: 'The upload is blocked because the file contains a password.',
    check: (events) => {
      const e = latest(events, (x) => x.outcome.startsWith('file_'));
      return { pass: Boolean(e), detail: e ? `${e.outcome.replace(/_/g, ' ')} (${e.rule_id})` : 'No file-upload event yet' };
    },
  },
  {
    id: 'policy-change',
    title: '8. A policy change takes effect',
    instructions:
      'In Data Protection Rules set "Email addresses" to Block. In the extension popup click "Sync Policies". Send the prompt from step 4 again.',
    expected: 'This time the email prompt is blocked instead of warned. (Set it back to Warn afterwards.)',
    check: (events) => {
      const e = latest(events, (x) => x.rule_id === 'pii.email' && x.action === 'BLOCK');
      return { pass: Boolean(e), detail: e ? 'Email prompt blocked after the policy change' : 'No blocked email prompt yet' };
    },
  },
  {
    id: 'offline',
    title: '9. Protection continues offline',
    instructions:
      'Stop the backend (or disconnect the network), send the prompt from step 2 again, then restore the connection and click "Sync Policies" in the popup.',
    expected: 'The prompt is still blocked while offline (rules are cached in the browser). After reconnecting, the queued event appears in Prompts & Risk Events.',
    manual: true,
  },
];

const STORAGE_KEY = 'agentshield_demo_started_at';

export const DemoGuide: React.FC<{ onNavigate: (tab: NavTab) => void }> = ({ onNavigate }) => {
  const [startedAt, setStartedAt] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [onlineBrowsers, setOnlineBrowsers] = useState(0);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState('');

  const runChecks = async () => {
    if (!startedAt) return;
    setChecking(true);
    try {
      const [ev, ep] = await Promise.all([api.getEvents({ since: startedAt, pageSize: 100, timeFrame: 'All' }), api.getEndpoints()]);
      setEvents(ev.items);
      setOnlineBrowsers(ep.online);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    runChecks();
    const t = setInterval(runChecks, 10000);
    return () => clearInterval(t);
  }, [startedAt]);

  const start = () => {
    const now = new Date().toISOString();
    try {
      localStorage.setItem(STORAGE_KEY, now);
    } catch {
      // ignore
    }
    setStartedAt(now);
  };

  const copy = (text: string, id: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(id);
      setTimeout(() => setCopied(''), 1500);
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '980px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <PlayCircle size={22} color="var(--color-primary)" /> Guided Demo
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            Each check looks for real events recorded since you started the demo. Use the synthetic test data shown; never real
            credentials or personal data.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {startedAt && (
            <button className="btn-secondary" onClick={runChecks} disabled={checking}>
              <RefreshCw size={14} /> {checking ? 'Checking...' : 'Check now'}
            </button>
          )}
          <button className="btn-primary" onClick={start}>{startedAt ? 'Restart demo' : 'Start demo'}</button>
        </div>
      </div>

      {startedAt && (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Counting events since {new Date(startedAt).toLocaleString()}. Results refresh every 10 seconds.
        </div>
      )}

      {STEPS.map((step) => {
        const result = startedAt && step.check ? step.check(events, { onlineBrowsers }) : null;
        return (
          <div key={step.id} className="glass-panel" style={{ padding: '16px 18px', display: 'flex', gap: '14px' }}>
            <div style={{ paddingTop: '2px' }}>
              {step.manual ? (
                <Circle size={20} color="var(--text-faint)" />
              ) : result?.pass ? (
                <CheckCircle2 size={20} color="var(--color-success)" />
              ) : result ? (
                <XCircle size={20} color="var(--text-faint)" />
              ) : (
                <Circle size={20} color="var(--text-faint)" />
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-main)' }}>{step.title}</div>
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>{step.instructions}</div>
              {step.testData && (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' }}>
                  <code style={{ flex: 1, padding: '6px 10px', background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)', borderRadius: '6px', fontSize: '12.5px', wordBreak: 'break-all' }}>
                    {step.testData}
                  </code>
                  <button className="btn-secondary" style={{ padding: '5px 10px', fontSize: '12px' }} onClick={() => copy(step.testData!, step.id)}>
                    <Copy size={12} /> {copied === step.id ? 'Copied' : 'Copy'}
                  </button>
                </div>
              )}
              <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', marginTop: '8px' }}>
                <strong>Expected:</strong> {step.expected}
              </div>
              {result && (
                <div style={{ fontSize: '12.5px', marginTop: '6px', color: result.pass ? 'var(--color-success-text)' : 'var(--text-muted)' }}>
                  <strong>{result.pass ? 'Verified:' : 'Not seen yet:'}</strong> {result.detail}
                </div>
              )}
              {step.manual && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>Verify this one by watching the browser.</div>}
            </div>
          </div>
        );
      })}

      <div style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>
        After the demo, review everything in{' '}
        <button onClick={() => onNavigate('events')} style={{ background: 'none', border: 'none', color: 'var(--color-primary)', cursor: 'pointer', padding: 0, fontSize: 'inherit' }}>Prompts & Risk Events</button>{' '}
        and the changes you made in{' '}
        <button onClick={() => onNavigate('audit')} style={{ background: 'none', border: 'none', color: 'var(--color-primary)', cursor: 'pointer', padding: 0, fontSize: 'inherit' }}>Admin Audit Log</button>.
      </div>
    </div>
  );
};
