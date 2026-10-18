import React, { useEffect, useMemo, useState } from 'react';
import { Ban, CalendarPlus, Gift, ShieldOff, X } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime, STATE_LABEL } from '../format';
import { Alert, PageHead, Pill, StatePill, type OpenDialog } from '../ui';
import type { Company, CompanyDetail, CompanyUsage, Plan } from '../types';

const PAGE_SIZE = 25;

export const Companies: React.FC<{ can: (p: string) => boolean; openDialog: OpenDialog }> = ({ can, openDialog }) => {
  const [rows, setRows] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState('ALL');
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [usage, setUsage] = useState<CompanyUsage | null>(null);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<CompanyDetail | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = () => api.companies().then(setRows).catch((e) => setError(e.message)).finally(() => setLoading(false));
  const openCompany = (id: string) => {
    api.companyUsage(id).then(setUsage).catch(() => setUsage(null));
    return api.company(id).then(setOpen).catch((e) => setError(e.message));
  };
  const refresh = async () => { await load(); if (open) await openCompany(open.id); };
  useEffect(() => {
    load();
    if (can('plans.read')) api.plans().then(setPlans).catch(() => undefined);
  }, []);

  const stateOf = (c: Company) => (c.entitlement.kind === 'INTERNAL' && c.entitlement.state === 'SUBSCRIPTION_ACTIVE' ? 'INTERNAL' : c.entitlement.state);
  const filtered = useMemo(() => rows.filter((c) =>
    `${c.name} ${c.owner_email || ''} ${c.id}`.toLowerCase().includes(query.toLowerCase())
    && (stateFilter === 'ALL' || stateOf(c) === stateFilter)
    && (typeFilter === 'ALL' || (c.account_type || 'COMPANY') === typeFilter),
  ), [rows, query, stateFilter, typeFilter]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const shown = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const act = (fn: () => Promise<unknown>, ok: string) => async () => { await fn(); setNotice(ok); await refresh(); };

  const exportCsv = () => {
    const header = ['company_id', 'name', 'owner_email', 'accounts', 'state', 'plan', 'ends', 'browsers_used', 'browser_limit', 'registered', 'suspended'];
    const lines = filtered.map((c) => [c.id, c.name, c.owner_email || '', c.users, stateOf(c), c.entitlement.plan_code || '', c.entitlement.expires_at || '',
      c.entitlement.devices_used, c.entitlement.device_limit ?? '', c.created_at || '', c.suspended_at ? 'yes' : 'no']
      .map((v) => `"${String(v).replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`).join(','));
    const url = URL.createObjectURL(new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `agentshield-companies-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stack">
      <PageHead title="Accounts" sub="Every customer account (individuals and company workspaces), its plan, usage, credits and browsers. Sensitive actions need a reason and are audited."
        right={<button type="button" className="btn btn-sm" onClick={exportCsv} disabled={!filtered.length}>Export CSV</button>} />
      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{notice}</Alert>
      <div className={open ? 'split' : ''}>
        <section className="card">
          <div className="card-pad row" style={{ paddingBottom: 12 }}>
            <input className="input" style={{ flex: '1 1 260px' }} placeholder="Search name, owner email or company ID" value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(0); }} aria-label="Search companies" />
            <select className="select" style={{ width: 170 }} value={stateFilter} onChange={(e) => { setStateFilter(e.target.value); setPage(0); }} aria-label="Filter by status">
              <option value="ALL">All statuses</option>
              {['TRIAL_ACTIVE', 'SUBSCRIPTION_ACTIVE', 'CREDITS_ACTIVE', 'FREE_ACTIVE', 'FREE_PAUSED', 'INTERNAL', 'LIMIT_REACHED', 'CAP_REACHED', 'NO_CREDITS', 'EXPIRED', 'NONE', 'REVOKED', 'SUSPENDED']
                .map((s) => <option key={s} value={s}>{STATE_LABEL[s]}</option>)}
            </select>
            <select className="select" style={{ width: 150 }} value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setPage(0); }} aria-label="Filter by account type">
              <option value="ALL">All types</option>
              <option value="INDIVIDUAL">Individuals</option>
              <option value="COMPANY">Companies</option>
            </select>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Account</th><th>Status</th><th>Ends</th><th>Checks / credits</th><th>Browsers</th><th>Registered</th></tr></thead>
              <tbody>
                {loading && <tr><td colSpan={6} className="empty">Loading...</td></tr>}
                {!loading && shown.length === 0 && <tr><td colSpan={6} className="empty">No accounts match.</td></tr>}
                {shown.map((c) => (
                  <tr key={c.id} className={`clickable ${open?.id === c.id ? 'selected' : ''}`} onClick={() => openCompany(c.id)}>
                    <td>
                      <div className="cell-main">{c.name} <span className="tag">{(c.account_type || 'COMPANY') === 'INDIVIDUAL' ? 'individual' : 'company'}</span></div>
                      <div className="cell-sub">{c.owner_email || 'no admin'}{c.email_verified === false ? ' · email not confirmed' : ''} · {c.users} user{c.users === 1 ? '' : 's'}</div>
                    </td>
                    <td><StatePill ent={c.entitlement} /></td>
                    <td>{c.entitlement.expires_at ? formatDate(c.entitlement.expires_at) : '—'}</td>
                    <td>{(c.entitlement.checks_this_month ?? 0).toLocaleString()}<div className="cell-sub">{(c.entitlement.credit_balance ?? 0).toLocaleString()} credits</div></td>
                    <td>{c.entitlement.devices_used}{c.entitlement.device_limit ? ` / ${c.entitlement.device_limit}` : ''}</td>
                    <td>{formatDate(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-pad row" style={{ justifyContent: 'space-between', paddingTop: 12 }}>
            <span className="card-note">{filtered.length} compan{filtered.length === 1 ? 'y' : 'ies'}</span>
            <div className="row">
              <button type="button" className="btn btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
              <span className="card-note">Page {page + 1} of {pages}</span>
              <button type="button" className="btn btn-sm" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          </div>
        </section>

        {open && (
          <section className="card card-pad stack" style={{ position: 'sticky', top: 16 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div className="card-title" style={{ fontSize: 17 }}>{open.name}</div>
                <div className="cell-sub">Tenant <span className="tag">{open.id}</span></div>
                <div className="cell-sub">Customer since {formatDate(open.created_at)}{open.trial_claim ? ` · trial claimed ${formatDate(open.trial_claim.claimed_at)}` : ''}</div>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => setOpen(null)} aria-label="Close details"><X size={15} /></button>
            </div>
            <div className="row"><StatePill ent={open.entitlement} />{open.suspended_reason && <span className="cell-sub">Suspended: {open.suspended_reason}</span>}</div>

            <div className="card" style={{ padding: 12, boxShadow: 'none' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <div className="label" style={{ marginBottom: 2 }}>Usage this month</div>
                  <div className="cell-main">{(open.entitlement.checks_this_month ?? 0).toLocaleString()} prompt checks
                    {open.entitlement.check_limit ? ` of ${open.entitlement.check_limit.toLocaleString()} included` : ''}</div>
                  <div className="cell-sub">{(open.entitlement.credit_balance ?? 0).toLocaleString()} credits left{open.entitlement.monthly_cap ? ` · own limit ${open.entitlement.monthly_cap.toLocaleString()}` : ''}</div>
                </div>
                {can('licenses.manage') && (
                  <div className="row">
                    {can('licenses.exception') && (
                      <button type="button" className="btn btn-sm" onClick={() => openDialog({
                        title: `Add credits to ${open.name}`, message: 'Credits without a verified payment are an exception and are recorded as such.',
                        fields: [{ name: 'n', label: 'Credits to add', type: 'number', initial: '100', minLength: 1 }, { name: 'reason', label: 'Reason (recorded)', minLength: 3 }],
                        confirmLabel: 'Add credits',
                        onConfirm: async (v) => act(() => api.adjustCredits(open.id, Math.abs(Math.floor(Number(v.n))), v.reason.trim()), 'Credits added.')(),
                      })}>Add credits</button>
                    )}
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => openDialog({
                      title: `Remove credits from ${open.name}`, message: 'For abuse or corrections. The balance never goes below zero.',
                      fields: [{ name: 'n', label: 'Credits to remove', type: 'number', initial: '100', minLength: 1 }, { name: 'reason', label: 'Reason (recorded)', minLength: 3 }],
                      confirmLabel: 'Remove credits', danger: true,
                      onConfirm: async (v) => act(() => api.adjustCredits(open.id, -Math.abs(Math.floor(Number(v.n))), v.reason.trim()), 'Credits removed.')(),
                    })}>Remove</button>
                  </div>
                )}
              </div>
              {usage && usage.days.length > 0 && (
                <div className="mini-bars" aria-label="Daily prompt checks, last 60 days">
                  {usage.days.map((d) => {
                    const max = Math.max(1, ...usage.days.map((x) => x.prompt_checks));
                    return <span key={d.day} title={`${d.day}: ${d.prompt_checks}`} style={{ height: `${Math.max(4, (d.prompt_checks / max) * 100)}%` }} />;
                  })}
                </div>
              )}
              {usage && usage.ledger.length > 0 && (
                <details style={{ marginTop: 8 }}>
                  <summary className="cell-sub" style={{ cursor: 'pointer' }}>Credit history ({usage.ledger.length})</summary>
                  {usage.ledger.map((l, i) => (
                    <div key={i} className="cell-sub">{formatDateTime(l.created_at)} · {l.kind} {l.delta >= 0 ? '+' : ''}{l.delta} → {l.balance_after} · {l.created_by}{l.note ? ` · ${l.note}` : ''}</div>
                  ))}
                </details>
              )}
            </div>

            <div className="row">
              {can('licenses.manage') && (
                <button type="button" className="btn btn-sm btn-primary" onClick={() => openDialog({
                  title: `Grant a licence to ${open.name}`,
                  message: can('licenses.exception')
                    ? 'Paid plans granted here are recorded as an exception (no verified payment). Give the invoice or approval reference.'
                    : 'You can grant trial licences. Paid plans without a verified payment need a platform owner.',
                  fields: [
                    { name: 'plan', label: 'Plan', type: 'select', initial: 'trial',
                      options: plans.filter((p) => p.kind !== 'CREDITS' && p.kind !== 'FREE' && (p.kind === 'TRIAL' || can('licenses.exception'))).map((p) => ({ value: p.code, label: `${p.name}${p.kind !== 'TRIAL' ? ' (exception)' : ''}` })) },
                    { name: 'reason', label: 'Reason (recorded)', minLength: 3, placeholder: 'e.g. invoice 1042 paid by bank transfer' },
                  ],
                  confirmLabel: 'Grant licence',
                  onConfirm: async (v) => act(() => api.grantLicence(open.id, v.plan, v.reason.trim()), 'Licence granted.')(),
                })}><Gift size={14} /> Grant licence</button>
              )}
              {can('companies.suspend') && (open.suspended_at ? (
                <button type="button" className="btn btn-sm" onClick={() => openDialog({
                  title: `Lift the suspension of ${open.name}?`, message: 'Its browsers reconnect at their next request.', confirmLabel: 'Lift suspension',
                  onConfirm: act(() => api.unsuspendCompany(open.id), 'Suspension lifted.'),
                })}>Lift suspension</button>
              ) : (
                <button type="button" className="btn btn-sm btn-danger" onClick={() => openDialog({
                  title: `Suspend ${open.name}?`, message: 'All its browsers are locked at their next request and its admins cannot use the portal features.',
                  fields: [{ name: 'reason', label: 'Reason (recorded and shown to the operator team)', minLength: 3 }],
                  confirmLabel: 'Suspend company', danger: true,
                  onConfirm: async (v) => act(() => api.suspendCompany(open.id, v.reason.trim()), 'Company suspended.')(),
                })}><Ban size={14} /> Suspend</button>
              ))}
            </div>

            <div>
              <div className="label">Licences</div>
              <div className="stack" style={{ gap: 8 }}>
                {open.licences.length === 0 && <div className="cell-sub">No licences.</div>}
                {open.licences.map((l) => (
                  <div key={l.id} className="card" style={{ padding: 12, boxShadow: 'none' }}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <strong>{l.plan_code}</strong>
                      <Pill tone={l.status === 'ACTIVE' ? 'ok' : l.status === 'SCHEDULED' ? 'info' : 'bad'}>{l.status.toLowerCase()}</Pill>
                    </div>
                    <div className="cell-sub">{formatDate(l.starts_at)} → {l.expires_at ? formatDate(l.expires_at) : 'no end'} · {l.device_limit} browsers{l.payment_ref ? ` · ${l.payment_ref}` : ''}</div>
                    {can('licenses.manage') && l.status !== 'REVOKED' && l.status !== 'EXPIRED' && (
                      <div className="row" style={{ marginTop: 8 }}>
                        {l.expires_at && (l.kind === 'TRIAL' || can('licenses.exception')) && (
                          <button type="button" className="btn-link" onClick={() => openDialog({
                            title: 'Extend licence', message: l.kind === 'TRIAL' ? undefined : 'Extending paid time is an exception and is recorded as such.',
                            fields: [{ name: 'days', label: 'Add days', type: 'number', initial: '7', minLength: 1 }, { name: 'reason', label: 'Reason (recorded)', minLength: 3 }],
                            confirmLabel: 'Extend',
                            onConfirm: async (v) => act(() => api.extendLicence(l.id, Number(v.days), v.reason.trim()), 'Licence extended.')(),
                          })}><CalendarPlus size={13} /> Extend</button>
                        )}
                        <button type="button" className="btn-link" onClick={() => openDialog({
                          title: 'Browser limit', fields: [{ name: 'limit', label: 'Maximum active browsers', type: 'number', initial: String(l.device_limit), minLength: 1 }],
                          confirmLabel: 'Save', onConfirm: async (v) => act(() => api.setBrowserLimit(l.id, Number(v.limit)), 'Browser limit updated.')(),
                        })}>Browser limit</button>
                        <button type="button" className="btn-link" style={{ color: 'var(--bad)' }} onClick={() => openDialog({
                          title: 'Revoke this licence?', message: 'The company loses access at its next request unless another licence is active.',
                          fields: [{ name: 'reason', label: 'Reason (recorded)', minLength: 3 }], confirmLabel: 'Revoke licence', danger: true,
                          onConfirm: async (v) => act(() => api.revokeLicence(l.id, v.reason.trim()), 'Licence revoked.')(),
                        })}><ShieldOff size={13} /> Revoke</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {open.adjustments.length > 0 && (
              <details>
                <summary className="label" style={{ cursor: 'pointer' }}>Licence changes ({open.adjustments.length})</summary>
                {open.adjustments.map((a, i) => (
                  <div key={i} className="cell-sub">{formatDateTime(a.at)} · {a.by}: {a.reason} ({formatDate(a.old_expires_at)} → {formatDate(a.new_expires_at)})</div>
                ))}
              </details>
            )}

            <div>
              <div className="label">Accounts ({open.users.length})</div>
              {open.users.map((u) => (
                <div key={u.id} className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <div><div className="cell-main" style={{ fontSize: 13 }}>{u.email}</div><div className="cell-sub">{u.role.toLowerCase()}{u.active ? '' : ' · suspended'}</div></div>
                  {can('users.suspend') && (u.active ? (
                    <button type="button" className="btn-link" style={{ color: 'var(--bad)' }} onClick={() => openDialog({
                      title: `Suspend ${u.email}?`, message: 'Signs the account out everywhere and blocks sign-in.', confirmLabel: 'Suspend account', danger: true,
                      onConfirm: act(() => api.suspendUser(u.id), 'Account suspended.'),
                    })}>Suspend</button>
                  ) : (
                    <button type="button" className="btn-link" onClick={() => openDialog({
                      title: `Re-enable ${u.email}?`, confirmLabel: 'Re-enable', onConfirm: act(() => api.activateUser(u.id), 'Account re-enabled.'),
                    })}>Re-enable</button>
                  ))}
                </div>
              ))}
            </div>

            {can('devices.read') && (
              <div>
                <div className="label">Browsers ({open.devices.filter((d) => d.status !== 'REVOKED').length} active)</div>
                {open.devices.length === 0 && <div className="cell-sub">No browsers activated.</div>}
                {open.devices.slice(0, 25).map((d) => (
                  <div key={d.id} className="cell-sub">{d.browser || 'Browser'} · {d.status.toLowerCase()} · last seen {formatDateTime(d.last_seen_at)}</div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
};
