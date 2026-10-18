import React, { useEffect, useState } from 'react';
import { Ban, CheckCircle2, Mail, Monitor, RotateCcw, ShieldCheck, ShieldOff, Users as UsersIcon, X } from 'lucide-react';
import { SectionHeader } from '../components/SectionHeader';
import { api } from '../services/api';
import { Account, AccountRole, AuthorizedDevice, OrgSettings, PendingInvite } from '../types';

/** Server times are UTC; some databases return them without a timezone suffix. */
const formatDate = (value?: string) =>
  value ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : value + 'Z').toLocaleString() : '—';

const ROLE_LABEL: Record<AccountRole, string> = {
  ADMIN: 'Administrator',
  VIEWER: 'Viewer (read-only)',
  EMPLOYEE: 'Employee',
};

const DEVICE_STATUS: Record<string, { cls: string; label: string }> = {
  ACTIVE: { cls: 'status-active', label: 'Active' },
  PENDING: { cls: 'status-pending', label: 'Pending approval' },
  REVOKED: { cls: 'status-revoked', label: 'Revoked' },
};

export const Users: React.FC<{ currentUserId: string }> = ({ currentUserId }) => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [devices, setDevices] = useState<AuthorizedDevice[]>([]);
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AccountRole>('EMPLOYEE');
  const [sending, setSending] = useState(false);
  const [showRevoked, setShowRevoked] = useState(false);

  const load = async () => {
    try {
      const [u, d, s] = await Promise.all([api.getUsers(), api.getOrgDevices(), api.getOrgSettings()]);
      setAccounts(u.users);
      setInvites(u.pending_invites);
      setDevices(d);
      setSettings(s);
      setLoaded(true);
    } catch (e: any) {
      setError(e.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setError('');
    setNotice('');
    try {
      await fn();
      if (ok) setNotice(ok);
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setSending(true);
    await run(async () => {
      const sent = await api.inviteUser(email.trim(), role);
      setEmail('');
      setNotice(
        sent.delivery === 'log'
          ? `Invite created for ${sent.email}. Email is not configured on this server, so the link was written to the backend log (development only).`
          : `Invite emailed to ${sent.email}. The link expires ${formatDate(sent.expires_at)}.`
      );
    });
    setSending(false);
  };

  const toggleApproval = (on: boolean) =>
    run(() => api.updateOrgSettings({ require_device_approval: on }), on ? 'New browsers now wait for your approval.' : 'New browsers are approved automatically.');

  const pending = devices.filter((d) => d.status === 'PENDING');
  const visibleDevices = devices.filter((d) => d.status !== 'PENDING' && (showRevoked || d.status !== 'REVOKED'));
  const revokedCount = devices.filter((d) => d.status === 'REVOKED').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div>
        <h1 className="page-title">Users &amp; Devices</h1>
        <p className="page-subtitle">Invite people, manage their accounts, and control which browsers are authorized.</p>
      </div>

      {error && <div className="callout callout-warning" style={{ color: 'var(--color-danger-text)', background: 'var(--color-danger-bg)', borderColor: 'var(--color-danger-border)' }}>{error}</div>}
      {notice && <div className="callout" style={{ color: 'var(--color-success-text)', background: 'var(--color-success-bg)', border: '1px solid var(--color-success-border)' }}>{notice}</div>}

      {/* Invite */}
      <section className="glass-panel" style={{ padding: '24px' }}>
        <SectionHeader icon={<Mail size={18} />} title="Invite someone">
          The person receives a single-use link (valid 72 hours), sets a password, then connects their browser from
          <em>My activation</em>. People can also create an account themselves from the sign-in page (confirmed by
          email) unless self sign-up is turned off on the server.
        </SectionHeader>
        <form onSubmit={invite} className="form-panel">
          <div style={{ flex: '2 1 260px' }}>
            <label className="field-label" htmlFor="invite-email">Work email</label>
            <input id="invite-email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" style={{ width: '100%' }} />
          </div>
          <div style={{ flex: '1 1 160px' }}>
            <label className="field-label" htmlFor="invite-role">Role</label>
            <select id="invite-role" className="input" value={role} onChange={(e) => setRole(e.target.value as AccountRole)} style={{ width: '100%' }}>
              <option value="EMPLOYEE">Employee</option>
              <option value="VIEWER">Viewer (read-only dashboard)</option>
              <option value="ADMIN">Administrator</option>
            </select>
          </div>
          <button type="submit" className="btn-primary" disabled={sending} style={{ height: '38px', alignSelf: 'flex-end' }}>
            <Mail size={15} /> {sending ? 'Sending...' : 'Send invite'}
          </button>
        </form>

        {invites.length > 0 && (
          <div className="table-wrap" style={{ marginTop: '16px' }}>
            <table className="data-table">
              <thead>
                <tr><th>Pending invite</th><th>Role</th><th>Expires</th><th>Invited by</th><th /></tr>
              </thead>
              <tbody>
                {invites.map((i) => (
                  <tr key={i.id}>
                    <td style={{ fontWeight: 600, color: 'var(--text-main)' }}>{i.email}</td>
                    <td>{ROLE_LABEL[i.role]}</td>
                    <td>{formatDate(i.expires_at)}</td>
                    <td>{i.created_by || '—'}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button type="button" className="link-btn" onClick={() => run(() => api.inviteUser(i.email, i.role), `New invite sent to ${i.email}.`)}>
                        <RotateCcw size={13} /> Resend
                      </button>{' '}
                      <button type="button" className="btn-ghost-danger" onClick={() => run(() => api.cancelInvite(i.id))}>
                        <X size={14} /> Cancel
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Accounts */}
      <section className="glass-panel" style={{ padding: '24px' }}>
        <SectionHeader icon={<UsersIcon size={18} />} title="Accounts" right={<span className="chip">{accounts.filter((a) => a.active).length} active</span>}>
          Disabling an account immediately locks every browser activated with it.
        </SectionHeader>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Email</th><th>Role</th><th>Browsers</th><th>Created</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {loaded && accounts.length === 0 && (
                <tr><td colSpan={6} className="empty-cell">No accounts yet.</td></tr>
              )}
              {accounts.map((a) => (
                <tr key={a.id} className={a.active ? undefined : 'row-muted'}>
                  <td>
                    <div style={{ fontWeight: 600, color: 'var(--text-main)' }}>{a.email}</div>
                    {a.id === currentUserId && <div className="cell-sub">You</div>}
                  </td>
                  <td>
                    <select
                      className="input"
                      value={a.role}
                      disabled={a.id === currentUserId}
                      onChange={(e) => run(() => api.updateUser(a.id, { role: e.target.value as AccountRole }), `Role updated for ${a.email}.`)}
                      style={{ height: '32px', fontSize: '12.5px' }}
                    >
                      <option value="EMPLOYEE">Employee</option>
                      <option value="VIEWER">Viewer</option>
                      <option value="ADMIN">Administrator</option>
                    </select>
                  </td>
                  <td>{a.device_count}</td>
                  <td>{formatDate(a.created_at)}</td>
                  <td>
                    <span className={`status-pill ${a.active ? 'status-active' : 'status-revoked'}`}>
                      <span className="status-dot" /> {a.active ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {a.id !== currentUserId &&
                      (a.active ? (
                        <button
                          type="button"
                          className="btn-ghost-danger"
                          onClick={() => window.confirm(`Disable ${a.email}? All of their browsers are locked immediately.`) && run(() => api.updateUser(a.id, { active: false }), `${a.email} disabled.`)}
                        >
                          <Ban size={14} /> Disable
                        </button>
                      ) : (
                        <button type="button" className="link-btn" onClick={() => run(() => api.updateUser(a.id, { active: true }), `${a.email} enabled.`)}>
                          <CheckCircle2 size={13} /> Enable
                        </button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Devices */}
      <section className="glass-panel" style={{ padding: '24px' }}>
        <SectionHeader
          icon={<Monitor size={18} />}
          title="Authorized browsers"
          right={<span className="chip">{devices.filter((d) => d.status === 'ACTIVE').length} active</span>}
        >
          Every browser is bound to one account by a key that never leaves it. Revoking a browser locks it at its next
          request; it must be activated again with a new code.
        </SectionHeader>

        {settings && (
          <label className="option-row" style={{ cursor: 'pointer', marginBottom: '16px' }}>
            <input type="checkbox" checked={settings.require_device_approval} onChange={(e) => toggleApproval(e.target.checked)} />
            <span>
              <strong>Require admin approval for new browsers</strong>
              <div style={{ color: 'var(--text-muted)', marginTop: '2px', fontSize: '12.5px' }}>
                When on, a newly activated browser stays blocked until an administrator approves it here.
              </div>
            </span>
          </label>
        )}

        {pending.length > 0 && (
          <div className="table-wrap" style={{ marginBottom: '16px', borderColor: 'var(--color-warning-border)' }}>
            <table className="data-table">
              <thead><tr><th>Waiting for approval</th><th>Browser</th><th>Requested</th><th /></tr></thead>
              <tbody>
                {pending.map((d) => (
                  <tr key={d.id}>
                    <td style={{ fontWeight: 600, color: 'var(--text-main)' }}>{d.user_email}</td>
                    <td>{d.browser || 'Browser'} {d.platform ? `· ${d.platform}` : ''}</td>
                    <td>{formatDate(d.created_at)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button type="button" className="btn-primary" style={{ padding: '5px 12px', fontSize: '12px' }} onClick={() => run(() => api.approveDevice(d.id), 'Browser approved.')}>
                        <ShieldCheck size={14} /> Approve
                      </button>{' '}
                      <button type="button" className="btn-ghost-danger" onClick={() => run(() => api.revokeDevice(d.id), 'Request rejected.')}>
                        <X size={14} /> Reject
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Account</th><th>Browser</th><th>Activated</th><th>Last seen</th><th>Status</th><th /></tr></thead>
            <tbody>
              {loaded && visibleDevices.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    <Monitor size={22} color="var(--text-faint)" />
                    <div>No authorized browsers yet. They appear here once people activate the extension.</div>
                  </td>
                </tr>
              )}
              {visibleDevices.map((d) => (
                <tr key={d.id} className={d.status === 'REVOKED' ? 'row-muted' : undefined}>
                  <td style={{ fontWeight: 600, color: 'var(--text-main)' }}>{d.user_email || d.user_id}</td>
                  <td>
                    {d.browser || 'Browser'}
                    <div className="cell-sub">{d.platform || ''}</div>
                  </td>
                  <td>{formatDate(d.created_at)}</td>
                  <td>{formatDate(d.last_seen_at)}</td>
                  <td>
                    <span className={`status-pill ${DEVICE_STATUS[d.status].cls}`}>
                      <span className="status-dot" /> {DEVICE_STATUS[d.status].label}
                    </span>
                    {d.status === 'REVOKED' && d.revoked_by && <div className="cell-sub">by {d.revoked_by}</div>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {d.status === 'ACTIVE' && (
                      <button
                        type="button"
                        className="btn-ghost-danger"
                        onClick={() => window.confirm(`Revoke this browser of ${d.user_email}? It is locked at its next request.`) && run(() => api.revokeDevice(d.id), 'Browser revoked.')}
                      >
                        <ShieldOff size={14} /> Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {revokedCount > 0 && (
          <button type="button" className="link-btn" onClick={() => setShowRevoked((v) => !v)} style={{ marginTop: '10px' }}>
            {showRevoked ? 'Hide' : 'Show'} {revokedCount} revoked browser{revokedCount === 1 ? '' : 's'}
          </button>
        )}
      </section>
    </div>
  );
};
