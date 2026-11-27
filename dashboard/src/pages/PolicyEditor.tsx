import React, { useEffect, useState } from 'react';
import { Eye, ShieldAlert, ShieldCheck, Sparkles } from 'lucide-react';
import { OrgSettings, Policy, PolicyAction, RuleCatalogItem, SeverityLevel } from '../types';
import { api } from '../services/api';

interface PolicyEditorProps {
  policies: Policy[];
  policyVersion: number;
  isAdmin: boolean;
  onRefresh: () => void;
  settings: OrgSettings | null;
}

const ACTIONS: Array<{ value: PolicyAction; label: string; help: string }> = [
  { value: 'BLOCK', label: 'Block', help: 'Stop it. The employee must remove the data first.' },
  { value: 'REDACT', label: 'Redact', help: 'Replace the data with [REDACTED] and send the rest (prompts only; files are blocked).' },
  { value: 'WARN', label: 'Warn', help: 'Ask the employee to confirm and give a reason before sending.' },
  { value: 'MONITOR', label: 'Monitor', help: 'Let it through silently but record it for review.' },
  { value: 'ALLOW', label: 'Allow', help: 'Let it through and do not record a violation.' },
];

const PRESETS: Array<{ id: 'recommended' | 'strict' | 'monitor'; title: string; text: string; icon: React.ReactNode }> = [
  { id: 'recommended', title: 'Recommended', text: 'Block credentials, cards and Aadhaar; warn on other personal data and file uploads; redact keywords.', icon: <ShieldCheck size={18} color="var(--color-primary)" /> },
  { id: 'strict', title: 'Strict', text: 'Block every rule, including all file uploads to AI tools.', icon: <ShieldAlert size={18} color="var(--color-danger)" /> },
  { id: 'monitor', title: 'Monitor only', text: 'Never interrupt employees; record everything for review. Good for a first week.', icon: <Eye size={18} color="#6d28d9" /> },
];

const selectStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: '6px',
  background: '#ffffff',
  border: '1px solid var(--border-default)',
  color: 'var(--text-main)',
  fontSize: '13px',
};

export const PolicyEditor: React.FC<PolicyEditorProps> = ({ policies, policyVersion, isAdmin, onRefresh, settings }) => {
  const [catalog, setCatalog] = useState<RuleCatalogItem[]>([]);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Rules as the server saved them after a change, shown at once (the page's full refresh follows a moment later).
  // Without this a switch showed its old state until the refresh came back, so it looked as if the click had failed.
  const [saved, setSaved] = useState<Record<string, Policy>>({});
  const [secretSettings, setSecretSettings] = useState<OrgSettings | null>(null);
  const [prefixes, setPrefixes] = useState('');
  const [hosts, setHosts] = useState('');

  useEffect(() => {
    if (settings) {
      setSecretSettings(settings);
      setPrefixes((settings.credential_prefixes ?? []).join(', '));
      setHosts((settings.secret_protected_hosts ?? []).join(', '));
    }
  }, [settings]);

  useEffect(() => {
    api.getRuleCatalog().then(setCatalog).catch(() => setCatalog([]));
  }, []);

  // Every saved change increases the rule's version, so the newest copy wins. Refreshes started by quick clicks
  // can come back out of order; an older one must not put a switch back to its old state.
  const newest = (p: Policy): Policy => (saved[p.id] && saved[p.id].version > p.version ? saved[p.id] : p);

  const flash = (tone: 'ok' | 'error', text: string) => {
    setMessage({ tone, text });
    setTimeout(() => setMessage(null), 5000);
  };

  const saveSecretSettings = async (changes: Partial<OrgSettings>) => {
    setBusy('secrets');
    try {
      setSecretSettings(await api.updateOrgSettings(changes));
      flash('ok', 'Credential protection settings saved. Connected browsers sync within about a minute.');
      onRefresh();
    } catch (e: any) {
      flash('error', e.message || 'Could not save credential protection settings.');
    } finally {
      setBusy(null);
    }
  };

  const update = async (p: Policy, changes: Partial<Policy>, label: string) => {
    setBusy(p.id);
    try {
      const updated = await api.updatePolicy(p.id, changes);
      setSaved((prev) => ({ ...prev, [updated.id]: updated }));
      flash('ok', `${label}. Connected browsers apply this within about a minute.`);
      onRefresh();
    } catch (e: any) {
      flash('error', e.message || 'Could not save the change.');
    } finally {
      setBusy(null);
    }
  };

  const applyPreset = async (preset: 'recommended' | 'strict' | 'monitor', title: string) => {
    if (!window.confirm(`Apply the "${title}" preset? This changes the action of every rule.`)) return;
    setBusy(preset);
    try {
      await api.applyPreset(preset);
      flash('ok', `"${title}" preset applied. Connected browsers apply this within about a minute.`);
      onRefresh();
    } catch (e: any) {
      flash('error', e.message || 'Could not apply the preset.');
    } finally {
      setBusy(null);
    }
  };

  const byRule = new Map(policies.map((p) => [p.rule_id, newest(p)]));
  const legacySecretBlock = Array.from(byRule.values())
    .some((rule) => rule.rule_id.startsWith('secret.') && rule.enabled && rule.action === 'BLOCK');
  const rows = catalog.length
    ? catalog.map((c) => ({ c, p: byRule.get(c.rule_id) })).filter((r) => r.p)
    : policies.map((p) => ({ c: undefined as RuleCatalogItem | undefined, p: newest(p) }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-main)' }}>Data Protection Rules</h2>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', maxWidth: '720px' }}>
            What happens when an employee sends sensitive data to an AI tool. Checks run inside the employee's browser before
            anything is sent. When several rules match, the strictest action wins.
          </p>
        </div>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)', padding: '6px 12px', borderRadius: '8px' }}>
          Policy version v{policyVersion}
        </span>
      </div>

      {message && (
        <div
          role="status"
          style={{
            padding: '10px 14px',
            borderRadius: '8px',
            fontSize: '13px',
            background: message.tone === 'ok' ? 'var(--color-success-bg)' : 'var(--color-danger-bg)',
            color: message.tone === 'ok' ? 'var(--color-success-text)' : 'var(--color-danger-text)',
            border: `1px solid ${message.tone === 'ok' ? 'var(--color-success-border)' : 'var(--color-danger-border)'}`,
          }}
        >
          {message.text}
        </div>
      )}

      {secretSettings && (
        <section className="glass-panel" style={{ padding: '16px', display: 'grid', gap: '10px' }}>
          <label>
            <input type="checkbox" role="switch"
              checked={secretSettings.block_passwords_and_secrets ?? legacySecretBlock}
              disabled={!isAdmin || busy !== null}
              onChange={(e) => void saveSecretSettings({ block_passwords_and_secrets: e.target.checked })} />
            {' '}Block passwords and secrets
          </label>
          <p>Blocks high-confidence credentials on supported AI sites, managed native forms and recognized Gmail compose dialogs.</p>
          {secretSettings.block_passwords_and_secrets == null && (
            <p>Existing credential rules apply until you change this switch.</p>
          )}
          <label>
            Public credential prefixes (comma-separated)
            <input className="input-field" value={prefixes} disabled={!isAdmin || busy !== null}
              onChange={(e) => setPrefixes(e.target.value)} placeholder="corp_key_" />
          </label>
          <label>
            Managed form destinations (comma-separated hostnames)
            <input className="input-field" value={hosts} disabled={!isAdmin || busy !== null}
              onChange={(e) => setHosts(e.target.value)} placeholder="forms.example.com" />
          </label>
          {isAdmin && <button className="btn-secondary" style={{ justifySelf: 'start' }} disabled={busy !== null}
            onClick={() => void saveSecretSettings({
              credential_prefixes: prefixes.split(',').map((value) => value.trim()).filter(Boolean),
              secret_protected_hosts: hosts.split(',').map((value) => value.trim()).filter(Boolean),
            })}>Save prefixes and destinations</button>}
        </section>
      )}
      {isAdmin && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '14px' }}>
          {PRESETS.map((preset) => (
            <div key={preset.id} className="glass-panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, fontSize: '14px', color: 'var(--text-main)' }}>
                {preset.icon} {preset.title}
              </div>
              <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', flex: 1 }}>{preset.text}</div>
              <button className="btn-secondary" disabled={busy !== null} onClick={() => applyPreset(preset.id, preset.title)} style={{ alignSelf: 'flex-start' }}>
                <Sparkles size={14} /> {busy === preset.id ? 'Applying...' : 'Apply preset'}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="glass-panel" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
          <thead>
            <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
              <th style={{ padding: '12px 16px', fontWeight: 600 }}>What is detected</th>
              <th style={{ padding: '12px 16px', fontWeight: 600 }}>Action</th>
              <th style={{ padding: '12px 16px', fontWeight: 600 }}>Severity</th>
              <th style={{ padding: '12px 16px', fontWeight: 600 }}>Applies to</th>
              <th style={{ padding: '12px 16px', fontWeight: 600 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ c, p }) => {
              if (!p) return null;
              const disabled = !isAdmin || busy !== null;
              return (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--border-subtle)', opacity: p.enabled ? 1 : 0.6 }}>
                  <td style={{ padding: '14px 16px', maxWidth: '420px' }}>
                    <div style={{ fontWeight: 600, color: 'var(--text-main)' }}>{c?.name || p.name}</div>
                    {c && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{c.description}</div>}
                    <div style={{ fontSize: '11px', color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', marginTop: '4px' }}>
                      {p.rule_id}
                      {c && p.action !== c.default_action && <span style={{ fontFamily: 'var(--font-sans)' }}> • recommended: {c.default_action}</span>}
                    </div>
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <select
                      aria-label={`Action for ${c?.name || p.rule_id}`}
                      value={p.action}
                      disabled={disabled}
                      onChange={(e) => update(p, { action: e.target.value as PolicyAction }, `${c?.name || p.rule_id} set to ${e.target.value}`)}
                      style={selectStyle}
                      title={ACTIONS.find((a) => a.value === p.action)?.help}
                    >
                      {ACTIONS.map((a) => (
                        <option key={a.value} value={a.value}>{a.label}</option>
                      ))}
                    </select>
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <select
                      aria-label={`Severity for ${c?.name || p.rule_id}`}
                      value={p.severity}
                      disabled={disabled}
                      onChange={(e) => update(p, { severity: e.target.value as SeverityLevel }, 'Severity updated')}
                      style={selectStyle}
                    >
                      {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </td>
                  <td style={{ padding: '14px 16px', color: 'var(--text-muted)', fontSize: '12.5px' }}>
                    {!p.site_scope || p.site_scope === '*' ? 'All AI sites' : p.site_scope}
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <button
                      onClick={() => update(p, { enabled: !p.enabled }, `${c?.name || p.rule_id} ${p.enabled ? 'disabled' : 'enabled'}`)}
                      disabled={disabled}
                      style={{
                        padding: '4px 10px',
                        borderRadius: '9999px',
                        border: `1px solid ${p.enabled ? 'var(--color-success-border)' : 'var(--border-default)'}`,
                        cursor: disabled ? 'default' : 'pointer',
                        fontSize: '11px',
                        fontWeight: 700,
                        background: p.enabled ? 'var(--color-success-bg)' : 'var(--bg-subtle)',
                        color: p.enabled ? 'var(--color-success-text)' : 'var(--text-muted)',
                      }}
                    >
                      {p.enabled ? 'On' : 'Off'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="glass-panel" style={{ padding: '16px 20px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-main)', marginBottom: '10px' }}>What the actions mean</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px', fontSize: '12.5px' }}>
          {ACTIONS.map((a) => (
            <div key={a.value}>
              <strong style={{ color: 'var(--text-main)' }}>{a.label}:</strong> <span style={{ color: 'var(--text-muted)' }}>{a.help}</span>
            </div>
          ))}
        </div>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '10px' }}>
          Turning a rule <strong>Off</strong> means it is not checked at all. Employees marked <em>Restricted</em> have every Warn treated as Block;
          <em> Suspended</em> employees cannot send anything. Confidential keywords are managed in Deployment & Settings.
        </p>
      </div>
    </div>
  );
};
