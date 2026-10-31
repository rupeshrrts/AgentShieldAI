import React, { useEffect, useState } from 'react';
import { CheckCircle2, Circle, Copy, Download as DownloadIcon, ExternalLink, FileCheck2, Lock, Monitor, Package, Wifi } from 'lucide-react';
import { SectionHeader } from '../components/SectionHeader';
import { NavTab } from '../components/Sidebar';
import { api } from '../services/api';
import { AuthorizedDevice, BillingStatus, DistributionInfo, ReleaseInfo } from '../types';
import { ACCESS_STATES, formatDate, formatDateTime, parseUtc } from '../utils/format';

type Browser = 'chrome' | 'edge';

const BROWSER = {
  chrome: { name: 'Google Chrome', page: 'chrome://extensions' },
  edge: { name: 'Microsoft Edge', page: 'edge://extensions' },
};

/** A browser counts as "authorized" when the server saw it recently with an active licence. */
const ONLINE_MS = 20 * 60 * 1000;

/**
 * Download portal. Downloading needs an active plan (trial, paid, credits or Free plan): the server only
 * issues download links to such accounts. Nothing works until the browser is connected with a code.
 */
export const Download: React.FC<{ onNavigate: (tab: NavTab) => void; individual?: boolean }> = ({ onNavigate, individual = false }) => {
  const [info, setInfo] = useState<DistributionInfo | null | undefined>(undefined);
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [devices, setDevices] = useState<AuthorizedDevice[]>([]);
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [browser, setBrowser] = useState<Browser>('chrome');
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [dlError, setDlError] = useState('');

  useEffect(() => {
    api.getDistributionInfo().then(setInfo).catch(() => setInfo(null));
    api.getCurrentRelease().then(setRelease).catch(() => setRelease(null));
    const refresh = () => {
      api.getMyDevices().then(setDevices).catch(() => undefined);
      api.getBillingStatus().then(setStatus).catch(() => undefined);
    };
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, []);

  const ent = status?.entitlement;
  const licensed = !!ent && ACCESS_STATES.includes(ent.state);
  // Locked once the account status is known and it has no active plan (the server enforces this too)
  const locked = !!status && !licensed;
  const store = info?.store_links?.[browser] || null;
  const sha = info?.zip_sha256 || release?.sha256 || null;
  const live = devices.filter((d) => d.status !== 'REVOKED');

  const download = async (file: 'agentshield-extension.zip') => {
    setDlError('');
    setDownloading(true);
    try {
      await api.downloadFile(file);
    } catch (e: any) {
      setDlError(e.message || 'Could not start the download.');
    } finally {
      setTimeout(() => setDownloading(false), 1500);
    }
  };

  const copySha = async () => {
    if (!sha) return;
    await navigator.clipboard.writeText(sha).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // The browser extension (Chrome Web Store / Edge Add-ons, or the .zip) is the way to install AgentShield
  const extensionWay = (
    <>
  <section className="glass-panel" style={{ padding: '24px' }}>
    <SectionHeader
      icon={<Package size={18} />}
      title={`One browser at a time (any computer) ${info?.version || release?.version ? `· version ${info?.version || release?.version}` : ''}`}
      right={release?.published_at ? <span className="chip">Released {formatDate(release.published_at)}</span> : undefined}
    >
      Supported: Google Chrome {release?.min_chrome || '110'}+ and Microsoft Edge {release?.min_edge || '110'}+ on Windows, macOS and Linux.
      Other browsers are not supported.
    </SectionHeader>

    <div className="seg" role="tablist">
      {(['chrome', 'edge'] as Browser[]).map((b) => (
        <button key={b} type="button" role="tab" aria-selected={browser === b} className={browser === b ? 'active' : ''} onClick={() => setBrowser(b)}>
          {BROWSER[b].name}
        </button>
      ))}
    </div>

    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', margin: '16px 0' }}>
      {locked ? (
        <button type="button" className="btn-primary" disabled title="Needs an active plan">
          <Lock size={15} /> Download locked: no active plan
        </button>
      ) : store ? (
        <a className="btn-primary" href={store} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
          <ExternalLink size={15} /> Get it from the {browser === 'chrome' ? 'Chrome Web Store' : 'Edge Add-ons store'}
        </a>
      ) : info?.downloads?.extension_zip ? (
        <button type="button" className="btn-primary" disabled={downloading} onClick={() => download('agentshield-extension.zip')}>
          <DownloadIcon size={15} /> {downloading ? 'Starting download...' : 'Download extension (.zip)'}
        </button>
      ) : (
        <span className="callout callout-warning">The extension package is not published on this server yet. Contact support.</span>
      )}
    </div>

    <ol className="steps" style={{ marginLeft: 18 }}>
      {store ? (
        <>
          <li>Open the store page and click <strong>{browser === 'chrome' ? 'Add to Chrome' : 'Get'}</strong>.</li>
          <li>Pin AgentShield: click the puzzle-piece icon in the toolbar, then the pin next to AgentShield.</li>
        </>
      ) : (
        <>
          <li>Download the .zip and <strong>extract it</strong> to a folder you will keep (the browser loads it from there). A .zip cannot be installed by double-clicking.</li>
          <li>Open <code>{BROWSER[browser].page}</code> and turn on <strong>Developer mode</strong>.</li>
          <li>Click <strong>Load unpacked</strong> and select the extracted folder.</li>
          <li>Pin AgentShield: click the puzzle-piece icon, then the pin next to AgentShield.</li>
        </>
      )}
      <li>Go to <button type="button" className="link-btn" onClick={() => onNavigate('activation')}>Connect browser</button>, generate a code, click the AgentShield icon, paste it and click <strong>Connect and verify</strong>.</li>
    </ol>

    {sha && !store && (
      <div style={{ marginTop: '14px' }}>
        <div className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><FileCheck2 size={14} /> Verify the download (SHA-256)</div>
        <div className="code-box code-box-sm">
          <code>{sha}</code>
          <button type="button" className="btn-secondary" onClick={copySha}><Copy size={14} /> {copied ? 'Copied' : 'Copy'}</button>
        </div>
        <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: 6 }}>
          Windows: <code>certutil -hashfile agentshield-extension-{info?.version}.zip SHA256</code> · macOS/Linux: <code>shasum -a 256 &lt;file&gt;</code>. The result must match.
        </div>
      </div>
    )}

    {release?.notes && (
      <details className="disclosure">
        <summary>Release notes</summary>
        <div style={{ whiteSpace: 'pre-wrap', fontSize: '12.5px' }}>{release.notes}</div>
      </details>
    )}
    <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: 12 }}>
      Updates: store installs{individual ? '' : ' and IT installs'} update automatically. A manually loaded copy must be replaced with the new
      .zip (then click reload in the extensions page); your connection is kept.
    </p>
  </section>
    </>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div>
        <h1 className="page-title">Download</h1>
        <p className="page-subtitle">Add the AgentShield extension to Chrome or Edge, then connect it to your account. No Windows program is needed.</p>
      </div>

      {status && !licensed && (
        <div className="callout callout-warning" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Lock size={16} />
          <span style={{ flex: 1, minWidth: 220 }}>
            The download unlocks once {individual ? 'your account' : 'your company'} has an active plan:{' '}
            start the free trial, choose a plan or buy credits{individual ? ' (if the page asks, confirm your email first)' : ''}.
          </span>
          <button type="button" className="btn-primary" onClick={() => onNavigate('account')}>Go to Account &amp; plan</button>
        </div>
      )}
      {dlError && <div className="callout callout-warning">{dlError}</div>}

      {extensionWay}

      {/* Connection status */}
      <section className="glass-panel" style={{ padding: '24px' }}>
        <SectionHeader icon={<Wifi size={18} />} title="Connection status">
          <strong>Downloaded</strong> happens on your computer, so it's invisible here. A browser shows as <strong>Connected</strong> once
          it's activated with your code, and as <strong>Authorized</strong> while it's in contact with the server and your plan is active.
        </SectionHeader>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Browser</th><th>Downloaded</th><th>Connected</th><th>Authorized</th><th>Last seen</th></tr></thead>
            <tbody>
              {live.length === 0 && (
                <tr><td colSpan={5} className="empty-cell"><Monitor size={22} color="var(--text-faint)" /><div>No browser connected yet.</div></td></tr>
              )}
              {live.map((d) => {
                const recent = d.last_seen_at ? Date.now() - parseUtc(d.last_seen_at).getTime() < ONLINE_MS : false;
                const authorized = d.status === 'ACTIVE' && recent && licensed;
                const why = d.status === 'PENDING' ? 'waiting for approval' : !licensed ? 'plan not active' : !recent ? 'not seen recently' : '';
                return (
                  <tr key={d.id}>
                    <td><strong style={{ color: 'var(--text-main)' }}>{d.browser || 'Browser'}</strong><div className="cell-sub">{d.computer_name ? `On ${d.computer_name} (Windows app)` : d.platform}</div></td>
                    <td><CheckCircle2 size={16} color="var(--color-success)" /></td>
                    <td>{d.status === 'ACTIVE' || d.status === 'PENDING' ? <CheckCircle2 size={16} color="var(--color-success)" /> : <Circle size={16} color="var(--text-faint)" />}</td>
                    <td>
                      {authorized ? <span className="status-pill status-active"><span className="status-dot" /> Authorized</span>
                        : <span className="status-pill status-revoked"><span className="status-dot" /> {why}</span>}
                    </td>
                    <td>{formatDateTime(d.last_seen_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
