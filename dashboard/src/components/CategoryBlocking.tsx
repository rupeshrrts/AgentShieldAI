import React, { useEffect, useState } from 'react';
import { Bug, Dice5, Film, Lock, Music, Search, ShieldBan, Users as UsersIcon, EyeOff } from 'lucide-react';
import { api } from '../services/api';
import { OrgSettings } from '../types';

const ICONS: Record<string, React.ReactNode> = {
  malware: <Bug size={18} />,
  adult: <EyeOff size={18} />,
  piracy: <Film size={18} />,
  gambling: <Dice5 size={18} />,
  social: <UsersIcon size={18} />,
  bypass: <Lock size={18} />,
  streaming: <Music size={18} />,
};

/**
 * Website categories the extension blocks (lists built into the extension) and Safe Search.
 * Everything shown comes from GET /api/v1/org/settings; only admins can change it.
 */
export const CategoryBlocking: React.FC<{ isAdmin: boolean }> = ({ isAdmin }) => {
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getOrgSettings().then(setSettings).catch((e) => setError(e.message || 'Could not load the settings.'));
  }, []);

  const save = async (key: string, updates: Partial<OrgSettings>) => {
    setSaving(key);
    setError('');
    try {
      setSettings(await api.updateOrgSettings(updates));
    } catch (e: any) {
      setError(e.message || 'Could not save the setting.');
    } finally {
      setSaving(null);
    }
  };

  if (!settings) {
    return error ? <div className="callout callout-warning">{error}</div> : null;
  }
  const catalog = settings.web_category_catalog || [];
  const on = settings.web_categories || {};

  return (
    <section className="glass-panel" style={{ padding: '22px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
        <ShieldBan size={20} color="var(--color-primary)" />
        <h2 style={{ fontSize: '16px', fontWeight: 800, margin: 0, color: 'var(--text-main)' }}>Category blocking</h2>
      </div>
      <p style={{ margin: '0 0 16px', fontSize: '13px', color: 'var(--text-muted)', maxWidth: '820px' }}>
        Block whole kinds of websites. The lists are built into the extension, so the check happens in the browser and the
        sites you visit are not sent anywhere. Changes reach connected browsers within 5 minutes. A site blocked by mistake?
        Add it below as <strong>ALLOW</strong>.
      </p>
      {error && <div className="callout callout-warning" style={{ marginBottom: '12px' }}>{error}</div>}

      <div className="category-grid">
        {catalog.map((c) => {
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
        })}

        <label className={`category-tile ${settings.safe_search ? 'on' : ''}`} style={{ cursor: isAdmin ? 'pointer' : 'default' }}>
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
      </div>
      {!isAdmin && <p style={{ margin: '10px 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>Only an administrator can change these.</p>}
    </section>
  );
};
