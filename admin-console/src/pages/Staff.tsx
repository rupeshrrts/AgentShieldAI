import React, { useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime } from '../format';
import { Alert, PageHead, Pill, type OpenDialog } from '../ui';
import type { StaffMe, StaffMember } from '../types';

const ROLE_HELP: Record<string, string> = {
  PLATFORM_OWNER: 'Everything, including staff, plans and paid-licence exceptions.',
  PLATFORM_ADMIN: 'Companies, suspensions, trial licences, releases, audit.',
  SECURITY_ANALYST: 'Companies, browsers, audit log and metrics. No billing or changes.',
  SUPPORT_AGENT: 'Company and account details needed for support. No billing, audit or changes.',
  BILLING_ADMIN: 'Payments, refunds, reconciliation, plans (read) and metrics.',
  READONLY_ANALYST: 'Read-only reports: companies, plans, billing, releases, metrics.',
};

/** Internal staff accounts (platform owner only). Every change is audited and takes effect immediately. */
export const Staff: React.FC<{ me: StaffMe; openDialog: OpenDialog }> = ({ me, openDialog }) => {
  const [rows, setRows] = useState<StaffMember[]>([]);
  const [roles, setRoles] = useState<{ role: string; label: string }[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // A reset password is returned once; it is shown here until the owner dismisses it
  const [temporary, setTemporary] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const load = () => api.staff().then((r) => { setRows(r.staff); setRoles(r.roles); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const roleOptions = roles.map((r) => ({ value: r.role, label: r.label }));
  const done = (msg: string) => { setNotice(msg); load(); };

  return (
    <div className="stack">
      <PageHead title="Staff & roles" sub="AgentShieldAI employees who can use this console. Two-step verification is mandatory for everyone."
        right={<button type="button" className="btn btn-primary btn-sm" onClick={() => openDialog({
          title: 'Invite a staff member', message: 'They get a single-use link (48 hours) to set a password, then must set up an authenticator app.',
          fields: [
            { name: 'email', label: 'Work email', minLength: 5, placeholder: 'name@agentshield.ai' },
            { name: 'name', label: 'Name (optional)' },
            { name: 'role', label: 'Role', type: 'select', initial: 'SUPPORT_AGENT', options: roleOptions },
          ],
          confirmLabel: 'Send invite',
          onConfirm: async (v) => {
            const r = await api.inviteStaff(v.email.trim(), v.role, v.name.trim() || undefined);
            done(r.delivery === 'log' ? `Invite created for ${r.email}. Email is not configured, so the link was written to the server log.` : `Invite sent to ${r.email}.`);
          },
        })}><UserPlus size={14} /> Invite staff</button>} />
      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{notice}</Alert>
      {temporary && (
        <section className="card card-pad stack">
          <div className="cell-main">Temporary password for {temporary.email}</div>
          <div className="card-note">Shown only now. Give it to them privately; they must choose a new password at their next sign-in (their authenticator is still required).</div>
          <div className="row">
            <span className="tag mono" style={{ wordBreak: 'break-all' }}>{temporary.password}</span>
            <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard.writeText(temporary.password).then(() => setCopied(true))}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => { setTemporary(null); setCopied(false); }}>Done</button>
          </div>
        </section>
      )}
      <section className="card">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Person</th><th>Role</th><th>Security</th><th>Last sign-in</th><th /></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td><div className="cell-main">{s.name || s.email}</div><div className="cell-sub">{s.email} · added {formatDate(s.created_at)}{s.created_by ? ` by ${s.created_by}` : ''}</div></td>
                  <td><div className="cell-main" style={{ fontWeight: 500 }}>{s.role_label}</div><div className="cell-sub">{ROLE_HELP[s.role]}</div></td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      {!s.active ? <Pill tone="bad">disabled</Pill> : s.invite_pending ? <Pill tone="info">invite pending</Pill> : <Pill tone="ok">active</Pill>}
                      {s.mfa_enabled ? <Pill tone="ok">2-step on</Pill> : <Pill tone="warn">2-step not set up</Pill>}
                      {s.must_change_password && <Pill tone="warn">temporary password</Pill>}
                    </div>
                  </td>
                  <td>{formatDateTime(s.last_login_at)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {s.id !== me.id && (
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button type="button" className="btn-link" onClick={() => openDialog({
                          title: `Change role of ${s.email}`, message: 'Takes effect immediately; their current sessions end.',
                          fields: [{ name: 'role', label: 'Role', type: 'select', initial: s.role, options: roleOptions }],
                          confirmLabel: 'Change role', onConfirm: async (v) => { await api.updateStaff(s.id, { role: v.role }); done('Role changed.'); },
                        })}>Role</button>
                        {!s.invite_pending && (
                          <button type="button" className="btn-link" onClick={() => openDialog({
                            title: `Reset the password of ${s.email}?`,
                            message: 'For a forgotten password. You get a one-time temporary password to give them; their sessions end and they choose a new password at their next sign-in.',
                            confirmLabel: 'Reset password', danger: true, onConfirm: async () => {
                              const r = await api.resetStaffPassword(s.id);
                              setCopied(false);
                              setTemporary({ email: r.email, password: r.temporary_password });
                              done('Password reset.');
                            },
                          })}>Reset password</button>
                        )}
                        {s.mfa_enabled && (
                          <button type="button" className="btn-link" onClick={() => openDialog({
                            title: `Reset two-step verification for ${s.email}?`, message: 'For a lost phone. They must set up a new authenticator at their next sign-in.',
                            confirmLabel: 'Reset', danger: true, onConfirm: async () => { await api.resetStaffMfa(s.id); done('Two-step verification reset.'); },
                          })}>Reset 2-step</button>
                        )}
                        <button type="button" className="btn-link" onClick={() => openDialog({
                          title: `End all sessions of ${s.email}?`, confirmLabel: 'End sessions',
                          onConfirm: async () => { await api.endStaffSessions(s.id); done('Sessions ended.'); },
                        })}>End sessions</button>
                        <button type="button" className="btn-link" style={{ color: s.active ? 'var(--bad)' : undefined }} onClick={() => openDialog({
                          title: s.active ? `Disable ${s.email}?` : `Re-enable ${s.email}?`,
                          message: s.active ? 'They are signed out at once and cannot sign in.' : undefined,
                          confirmLabel: s.active ? 'Disable' : 'Re-enable', danger: s.active,
                          onConfirm: async () => { await api.updateStaff(s.id, { active: !s.active }); done(s.active ? 'Account disabled.' : 'Account re-enabled.'); },
                        })}>{s.active ? 'Disable' : 'Re-enable'}</button>
                      </div>
                    )}
                    {s.id === me.id && <span className="cell-sub">you</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
