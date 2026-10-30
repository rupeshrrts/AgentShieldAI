import React, { useEffect, useState } from 'react';
import { ArrowRight, Copy, Download, KeyRound, Lock, Monitor, Plus, Tag, Trash2, UserCog } from 'lucide-react';
import { SectionHeader } from '../components/SectionHeader';
import { NavTab } from '../components/Sidebar';
import { api } from '../services/api';
import { DistributionInfo, OrgSettings, RestrictedKeyword } from '../types';

interface DeploymentProps {
  isAdmin: boolean;
  onChanged?: () => void;
  onNavigate?: (tab: NavTab) => void;
}

const SOURCE_NAMES: Record<string, string> = {
  self_hosted: 'this server (self-hosted)',
  chrome_web_store: 'Chrome Web Store',
  edge_add_ons: 'Edge Add-ons',
};

/** Machine-wide install through Chrome/Edge enterprise policies (Group Policy, Intune or any MDM); no Windows program. */
const SystemInstallSection: React.FC<{ copy: (t: string, l: string) => void; copied: string }> = ({ copy, copied }) => {
  const [info, setInfo] = useState<DistributionInfo | null | undefined>(undefined);
  useEffect(() => {
    api.getDistributionInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  const server = api.getApiBaseUrlForDisplay();

  return (
    <section className="glass-panel" style={{ padding: '24px' }}>
      <SectionHeader icon={<Monitor size={18} />} title="Install on company PCs">
        Push AgentShield with Chrome and Edge enterprise policy (Group Policy, Intune or any MDM): add the value below to{' '}
        <em>ExtensionInstallForcelist</em> and set the extension policy <em>apiUrl</em> to this server. No Windows program is
        needed, and users cannot remove a force-installed extension. Installing grants no access: each user still activates
        their browser with their own account.
      </SectionHeader>

      {info && (
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' }}>
          {info.downloads?.extension_zip && (
            <button type="button" className="btn-secondary" onClick={() => api.downloadFile('agentshield-extension.zip').catch((e) => window.alert(e.message))}>
              <Download size={15} /> Download extension (.zip, manual install)
            </button>
          )}
        </div>
      )}

      {info === undefined && <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Checking extension package...</div>}
      {info === null && (
        <div style={{ fontSize: '13px', color: 'var(--color-danger-text)' }}>
          The extension package has not been built on this server. On the server run{' '}
          <code>node scripts/packaging/pack-extension.js</code>.
        </div>
      )}
      {info && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '12.5px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '10px' }}>
            {(['chrome', 'edge'] as const).map((b) => (
              <div key={b} className="info-tile">
                <div style={{ fontWeight: 700, color: 'var(--text-main)' }}>{b === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'}</div>
                <div style={{ color: 'var(--text-muted)' }}>From {SOURCE_NAMES[info[b].source]} • version {info.version}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px', marginTop: '4px', wordBreak: 'break-all' }}>
                  {info[b].id};{info[b].update_url}
                </div>
              </div>
            ))}
          </div>

          {info.requires_managed_device && (
            <div className="callout callout-warning" style={{ display: 'block' }}>
              <strong>Managed PCs only for now.</strong> Chrome and Edge install a self-hosted extension only on PCs that are
              joined to Active Directory or Microsoft Entra ID, or enrolled in Intune/MDM. For other PCs, publish AgentShield to
              the Chrome Web Store and Edge Add-ons and set <code>CHROME_STORE_EXTENSION_ID</code> /{' '}
              <code>EDGE_STORE_EXTENSION_ID</code> on the server; the same policy then works everywhere.
            </div>
          )}

          <div>
            <div style={{ fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>
              Extension policy <em>apiUrl</em> (this server's address; no credential is included)
            </div>
            <div className="code-box code-box-sm">
              <code>{server}</code>
              <button type="button" className="btn-secondary" onClick={() => copy(server, 'apiUrl')}>
                <Copy size={14} /> {copied === 'apiUrl' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
          <div style={{ color: 'var(--text-muted)' }}>
            Details and ready-made policy files: DEPLOYMENT.md. Remove AgentShield by taking it off the force-install list.
          </div>
        </div>
      )}
    </section>
  );
};

const ErrorText: React.FC<{ message: string }> = ({ message }) =>
  message ? (
    <div style={{ marginTop: '10px', fontSize: '12.5px', color: 'var(--color-danger-text)' }}>{message}</div>
  ) : null;

export const Deployment: React.FC<DeploymentProps> = ({ isAdmin, onChanged, onNavigate }) => {
  const [copied, setCopied] = useState('');
  const [loadError, setLoadError] = useState('');

  // Keywords
  const [keywords, setKeywords] = useState<RestrictedKeyword[]>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [keywordError, setKeywordError] = useState('');

  // Settings
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<OrgSettings | null>(null);
  const [settingsMsg, setSettingsMsg] = useState('');

  // Password
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState('');
  const [passwordError, setPasswordError] = useState('');

  const loadAll = async () => {
    try {
      const [kw, st] = await Promise.all([api.getKeywords(), api.getOrgSettings()]);
      setKeywords(kw);
      setSettings(st);
      setSettingsDraft(st);
    } catch (err: any) {
      setLoadError(err.message || 'Failed to load settings');
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(''), 2000);
    } catch {
      setCopied('');
    }
  };

  const handleAddKeyword = async (e: React.FormEvent) => {
    e.preventDefault();
    setKeywordError('');
    if (!newKeyword.trim()) return;
    try {
      await api.addKeyword(newKeyword.trim());
      setNewKeyword('');
      setKeywords(await api.getKeywords());
    } catch (err: any) {
      setKeywordError(err.message);
    }
  };

  const handleDeleteKeyword = async (kw: RestrictedKeyword) => {
    try {
      await api.deleteKeyword(kw.id);
      setKeywords((prev) => prev.filter((k) => k.id !== kw.id));
    } catch (err: any) {
      setKeywordError(err.message);
    }
  };

  const handleSaveSettings = async () => {
    if (!settingsDraft) return;
    setSettingsMsg('');
    try {
      const saved = await api.updateOrgSettings({
        retention_days: settingsDraft.retention_days,
        store_clean_prompt_text: settingsDraft.store_clean_prompt_text,
        store_violation_prompt_text: settingsDraft.store_violation_prompt_text,
      });
      setSettings(saved);
      setSettingsDraft(saved);
      setSettingsMsg('Saved. Connected extensions apply this within about a minute.');
      onChanged?.();
    } catch (err: any) {
      setSettingsMsg(err.message);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordMsg('');
    setPasswordError('');
    if (newPassword.length < 12) {
      setPasswordError('New password must be at least 12 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match.');
      return;
    }
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordMsg('Password changed.');
      onChanged?.();
    } catch (err: any) {
      setPasswordError(err.message);
    }
  };

  const settingsDirty =
    settings &&
    settingsDraft &&
    (settings.retention_days !== settingsDraft.retention_days ||
      settings.store_clean_prompt_text !== settingsDraft.store_clean_prompt_text ||
      settings.store_violation_prompt_text !== settingsDraft.store_violation_prompt_text);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div>
        <h1 className="page-title">Deployment & Settings</h1>
        <p className="page-subtitle">Install the extension, manage confidential keywords, and control what prompt data is stored.</p>
      </div>
      <ErrorText message={loadError} />

      {!isAdmin && (
        <div className="glass-panel" style={{ padding: '12px 16px', fontSize: '13px', color: 'var(--color-warning-text)', background: 'var(--color-warning-bg)' }}>
          You have read-only access. Ask an administrator to change these settings.
        </div>
      )}

      {/* Browser activation now happens per user */}
      <section className="glass-panel" style={{ padding: '24px' }}>
        <SectionHeader
          icon={<KeyRound size={18} />}
          title="Browser activation"
          right={
            onNavigate && (
              <button type="button" className="btn-primary" onClick={() => onNavigate(isAdmin ? 'users' : 'activation')}>
                {isAdmin ? 'Users & Devices' : 'My activation'} <ArrowRight size={15} />
              </button>
            )
          }
        >
          Each person connects their own browser: they create an account (sign-up page or your invite from Users &amp;
          Devices), sign in, generate a single-use activation code in My activation and paste it into the extension. Installing or
          copying the extension grants nothing, and AI sites stay blocked until a browser is activated. Organization-wide
          enrollment codes are retired.
        </SectionHeader>
      </section>

      {/* System-wide installation */}
      {isAdmin && <SystemInstallSection copy={copy} copied={copied} />}

      {/* Keywords */}
      <section className="glass-panel" style={{ padding: '24px' }}>
        <SectionHeader icon={<Tag size={18} />} title="Confidential keywords" right={<span className="chip">{keywords.length}</span>}>
          Project codenames and internal terms. Prompts containing them trigger the <code>restricted.keyword</code> rule.
          Matching ignores case and only matches whole words.
        </SectionHeader>

        {isAdmin && (
          <form onSubmit={handleAddKeyword} style={{ display: 'flex', gap: '10px', marginBottom: '14px', flexWrap: 'wrap' }}>
            <input
              className="input mono"
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              placeholder="e.g. PROJECT-ORION"
              maxLength={120}
              style={{ flex: '1 1 260px' }}
            />
            <button type="submit" className="btn-primary">
              <Plus size={16} /> Add keyword
            </button>
          </form>
        )}
        <ErrorText message={keywordError} />

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: keywordError ? '10px' : 0 }}>
          {keywords.length === 0 && (
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No keywords. The keyword rule will never match.</span>
          )}
          {keywords.map((kw) => (
            <span key={kw.id} className="tag">
              {kw.keyword}
              {isAdmin && (
                <button type="button" onClick={() => handleDeleteKeyword(kw)} aria-label={`Remove ${kw.keyword}`} className="tag-remove">
                  <Trash2 size={13} />
                </button>
              )}
            </span>
          ))}
        </div>
      </section>

      {/* Privacy & retention */}
      {settingsDraft && (
        <section className="glass-panel" style={{ padding: '24px' }}>
          <SectionHeader icon={<Lock size={18} />} title="Privacy & retention">
            API keys and passwords are always masked before storage, whatever you choose here. Check your local employee
            monitoring rules (for example India's DPDP Act) and tell employees what is recorded.
          </SectionHeader>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' }}>
            <label className="option-row" style={{ cursor: isAdmin ? 'pointer' : 'default' }}>
              <input
                type="checkbox"
                disabled={!isAdmin}
                checked={settingsDraft.store_violation_prompt_text}
                onChange={(e) => setSettingsDraft({ ...settingsDraft, store_violation_prompt_text: e.target.checked })}
                style={{ marginTop: '3px' }}
              />
              <span>
                <strong>Store text of prompts that broke a rule</strong>
                <div style={{ color: 'var(--text-muted)', marginTop: '2px' }}>
                  Lets you see what was blocked, warned or redacted. Recommended for investigations.
                </div>
              </span>
            </label>

            <label className="option-row" style={{ cursor: isAdmin ? 'pointer' : 'default' }}>
              <input
                type="checkbox"
                disabled={!isAdmin}
                checked={settingsDraft.store_clean_prompt_text}
                onChange={(e) => setSettingsDraft({ ...settingsDraft, store_clean_prompt_text: e.target.checked })}
                style={{ marginTop: '3px' }}
              />
              <span>
                <strong>Store text of all other prompts</strong>
                <div style={{ color: 'var(--text-muted)', marginTop: '2px' }}>
                  Off by default. When off, allowed prompts are counted but their text never leaves the employee's browser.
                </div>
              </span>
            </label>

            <label className="option-row" style={{ alignItems: 'center' }}>
              <span style={{ fontWeight: 600 }}>Keep events for</span>
              <input
                type="number"
                className="input"
                min={1}
                max={3650}
                disabled={!isAdmin}
                value={settingsDraft.retention_days}
                onChange={(e) => setSettingsDraft({ ...settingsDraft, retention_days: Math.max(1, Number(e.target.value) || 1) })}
                style={{ width: '90px' }}
              />
              <span>days, then delete them automatically</span>
            </label>
          </div>

          {isAdmin && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '16px' }}>
              <button type="button" className="btn-primary" onClick={handleSaveSettings} disabled={!settingsDirty} style={{ opacity: settingsDirty ? 1 : 0.6 }}>
                Save settings
              </button>
              {settingsMsg && <span style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>{settingsMsg}</span>}
            </div>
          )}
        </section>
      )}

      {/* Change password */}
      <section className="glass-panel" style={{ padding: '24px' }}>
        <SectionHeader icon={<UserCog size={18} />} title="Change your password">
          Change the default password before going live. Minimum 12 characters.
        </SectionHeader>
        <form onSubmit={handleChangePassword} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px', alignItems: 'end' }}>
          <input className="input" type="password" autoComplete="current-password" placeholder="Current password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
          <input className="input" type="password" autoComplete="new-password" placeholder="New password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
          <input className="input" type="password" autoComplete="new-password" placeholder="Confirm new password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
          <button type="submit" className="btn-primary" style={{ justifyContent: 'center' }}>
            Change password
          </button>
        </form>
        <ErrorText message={passwordError} />
        {passwordMsg && <div style={{ marginTop: '10px', fontSize: '12.5px', color: 'var(--color-success-text)' }}>{passwordMsg}</div>}
      </section>
    </div>
  );
};
