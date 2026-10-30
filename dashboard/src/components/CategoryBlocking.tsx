import React, { useEffect, useState } from 'react';
import {
  Baby,
  Briefcase,
  Bug,
  Building2,
  Cpu,
  Crosshair,
  Dice5,
  EyeOff,
  Film,
  Flame,
  Gamepad2,
  Globe,
  Heart,
  Link2,
  Lock,
  Mail,
  MessageCircle,
  MonitorSmartphone,
  Music,
  Pill,
  Power,
  Radar,
  Search,
  ShieldAlert,
  ShieldBan,
  ShoppingCart,
  Terminal,
  UploadCloud,
  Users as UsersIcon,
} from 'lucide-react';
import { api } from '../services/api';
import { OrgSettings, WebCategory, WebCategoryPreset } from '../types';

const ICONS: Record<string, React.ReactNode> = {
  malware: <Bug size={18} />,
  cryptomining: <Cpu size={18} />,
  spyware: <Radar size={18} />,
  hacking: <Terminal size={18} />,
  remote_access: <MonitorSmartphone size={18} />,
  dyndns: <Globe size={18} />,
  shortener: <Link2 size={18} />,
  bypass: <Lock size={18} />,
  filesharing: <UploadCloud size={18} />,
  webmail: <Mail size={18} />,
  adult: <EyeOff size={18} />,
  mature: <Flame size={18} />,
  dating: <Heart size={18} />,
  gambling: <Dice5 size={18} />,
  drugs: <Pill size={18} />,
  hate: <ShieldAlert size={18} />,
  weapons: <Crosshair size={18} />,
  chat: <MessageCircle size={18} />,
  piracy: <Film size={18} />,
  social: <UsersIcon size={18} />,
  streaming: <Music size={18} />,
  games: <Gamepad2 size={18} />,
  shopping: <ShoppingCart size={18} />,
  jobsearch: <Briefcase size={18} />,
};

const PRESET_ICONS: Record<string, React.ReactNode> = {
  kids: <Baby size={16} />,
  workplace: <Building2 size={16} />,
  security: <Bug size={16} />,
  off: <Power size={16} />,
};

/**
 * Website categories the extension blocks (lists built into the extension) and Safe Search, grouped under the
 * server's headings, with one-click presets. Everything shown comes from GET /api/v1/org/settings; only admins
 * can change it.
 */
export const CategoryBlocking: React.FC<{ isAdmin: boolean }> = ({ isAdmin }) => {
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    api.getOrgSettings().then(setSettings).catch((e) => setError(e.message || 'Could not load the settings.'));
  }, []);

  const save = async (key: string, updates: Partial<OrgSettings>, done?: string) => {
    setSaving(key);
    setError('');
    setNotice('');
    try {
      setSettings(await api.updateOrgSettings(updates));
      if (done) setNotice(done);
    } catch (e: any) {
      setError(e.message || 'Could not save the setting.');
    } finally {
      setSaving(null);
    }
  };

  const applyPreset = (preset: WebCategoryPreset) => {
    if (!window.confirm(`Apply "${preset.name}"?\n\n${preset.description}\n\nEvery category switch is set; you can still change single switches afterwards.`)) return;
    const updates: Partial<OrgSettings> = { web_categories: preset.categories };
    if (typeof preset.safe_search === 'boolean') updates.safe_search = preset.safe_search;
    void save(`preset:${preset.id}`, updates, `"${preset.name}" applied. Connected browsers follow within about a minute.`);
  };

  if (!settings) {
    return error ? <div className="callout callout-warning">{error}</div> : null;
  }
  const catalog = settings.web_category_catalog || [];
  const groups = settings.web_category_groups || [];
  const presets = settings.web_category_presets || [];
  const on = settings.web_categories || {};
  const onCount = catalog.filter((c) => on[c.id]).length;

  const tile = (c: WebCategory) => {
    const enabled = Boolean(on[c.id]);
    return (
      <label key={c.id} className={`category-tile ${enabled ? 'on' : ''}`} style={{ cursor: isAdmin ? 'pointer' : 'default' }}>
        <span className="category-icon">{ICONS[c.id] || <ShieldBan size={18} />}</span>
        <span style={{ flex: 1 }}>
          <strong>{c.name}</strong>
          <span className="category-desc">{c.description}</span>
        </span>
        <input
          type="checkbox"
          className="switch"
          checked={enabled}
          disabled={!isAdmin || saving !== null}
          onChange={(e) => save(c.id, { web_categories: { [c.id]: e.target.checked } })}
          aria-label={`Block ${c.name}`}
        />
      </label>
    );
  };

  const safeSearchTile = (
    <label key="safe_search" className={`category-tile ${settings.safe_search ? 'on' : ''}`} style={{ cursor: isAdmin ? 'pointer' : 'default' }}>
      <span className="category-icon"><Search size={18} /></span>
      <span style={{ flex: 1 }}>
        <strong>Safe Search</strong>
        <span className="category-desc">Strict results on Google, Bing and DuckDuckGo, and YouTube Restricted Mode.</span>
      </span>
      <input
        type="checkbox"
        className="switch"
        checked={Boolean(settings.safe_search)}
        disabled={!isAdmin || saving !== null}
        onChange={(e) => save('safe_search', { safe_search: e.target.checked })}
        aria-label="Enforce Safe Search"
      />
    </label>
  );

  // Categories without a known group (older server) are shown under one heading
  const sections = groups.length
    ? groups.map((g) => ({ ...g, items: catalog.filter((c) => c.group === g.id) }))
    : [{ id: 'all', name: '', description: '', items: catalog }];

  return (
    <section className="glass-panel" style={{ padding: '22px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
        <ShieldBan size={20} color="var(--color-primary)" />
        <h2 style={{ fontSize: '16px', fontWeight: 800, margin: 0, color: 'var(--text-main)' }}>Category blocking</h2>
        <span className="chip" style={{ marginLeft: 'auto' }}>{onCount} of {catalog.length} on</span>
      </div>
      <p style={{ margin: '0 0 16px', fontSize: '13px', color: 'var(--text-muted)', maxWidth: '820px' }}>
        Block whole kinds of websites. The lists are built into the extension, so the check happens in the browser and the
        sites you visit are not sent anywhere. Only switched-on categories are blocked; changes reach connected browsers within
        about a minute. A site blocked by mistake? Add it below as <strong>ALLOW</strong>.
      </p>

      {presets.length > 0 && (
        <div style={{ marginBottom: '18px' }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px', letterSpacing: '0.04em' }}>
            QUICK SETTINGS
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                className="btn-secondary"
                title={p.description}
                disabled={!isAdmin || saving !== null}
                onClick={() => applyPreset(p)}
              >
                {PRESET_ICONS[p.id] || <ShieldBan size={16} />} {saving === `preset:${p.id}` ? 'Applying...' : p.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <div className="callout callout-warning" style={{ marginBottom: '12px' }}>{error}</div>}
      {notice && <div className="callout" style={{ marginBottom: '12px', display: 'block' }}>{notice}</div>}

      {sections.map((s) => (
        <div key={s.id} style={{ marginBottom: '18px' }}>
          {s.name && (
            <div style={{ marginBottom: '8px' }}>
              <div style={{ fontSize: '13.5px', fontWeight: 800, color: 'var(--text-main)' }}>{s.name}</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{s.description}</div>
            </div>
          )}
          <div className="category-grid">
            {s.items.map(tile)}
            {/* Safe Search belongs with the adult-content switches */}
            {(s.id === 'content' || (s.id === 'all' && !groups.length)) && safeSearchTile}
          </div>
        </div>
      ))}
      {!isAdmin && <p style={{ margin: '10px 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>Only an administrator can change these.</p>}
    </section>
  );
};
