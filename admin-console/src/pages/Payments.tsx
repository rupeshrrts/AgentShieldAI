import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api';
import { formatDateTime, formatMoney } from '../format';
import { Alert, PageHead, Pill, type OpenDialog } from '../ui';
import type { BillingOrder, WebhookEvent } from '../types';

const tone = (s: string) => (s === 'captured' || s === 'paid' ? 'ok' : ['failed', 'refunded', 'disputed'].includes(s) ? 'bad' : s === 'partially_refunded' ? 'warn' : 'muted');

/** Orders and payments from Razorpay. Plans activate only from verified payments; refunds go through Razorpay. */
export const Payments: React.FC<{ can: (p: string) => boolean; openDialog: OpenDialog }> = ({ can, openDialog }) => {
  const [orders, setOrders] = useState<BillingOrder[]>([]);
  const [hooks, setHooks] = useState<WebhookEvent[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = () => {
    api.orders().then(setOrders).catch((e) => setError(e.message));
    api.webhooks().then(setHooks).catch(() => undefined);
  };
  useEffect(() => { load(); }, []);

  const net = orders.flatMap((o) => o.payments).reduce<Record<string, number>>(
    (acc, p) => ({ ...acc, [p.currency]: (acc[p.currency] || 0) + p.amount_minor - p.refunded_minor }), {},
  );

  return (
    <div className="stack">
      <PageHead title="Payments" sub="Razorpay orders, payments, refunds and webhook deliveries."
        right={can('billing.reconcile') && (
          <button type="button" className="btn btn-sm" onClick={() => openDialog({
            title: 'Reconcile with Razorpay?', message: 'Re-checks unpaid one-time orders from the last 7 days and completes any payment whose webhook was missed.',
            confirmLabel: 'Reconcile',
            onConfirm: async () => { const r = await api.reconcile(); setNotice(`Checked ${r.checked} order(s), completed ${r.completed}.`); load(); },
          })}><RefreshCw size={14} /> Reconcile</button>
        )} />
      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{notice}</Alert>
      <section className="card">
        <div className="card-pad card-head" style={{ marginBottom: 0 }}>
          <div className="card-title">Orders</div>
          <span className="card-note">{Object.keys(net).length ? <>Net collected, latest 300 orders: <strong>{Object.entries(net).map(([c, v]) => formatMoney(v, c)).join(' · ')}</strong></> : 'No payments yet.'}</span>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Date</th><th>Company</th><th>Plan</th><th>Amount</th><th>Status</th><th /></tr></thead>
            <tbody>
              {orders.length === 0 && <tr><td colSpan={6} className="empty">No orders yet.</td></tr>}
              {orders.map((o) => {
                const p = o.payments[o.payments.length - 1];
                const left = p ? p.amount_minor - p.refunded_minor : 0;
                const status = p ? p.status : o.status;
                return (
                  <tr key={o.id}>
                    <td>{formatDateTime(p?.created_at || o.created_at)}</td>
                    <td className="cell-main">{o.organization || '—'}</td>
                    <td>{o.plan_code}{o.kind === 'subscription' ? ` · ${o.payments.length} charge(s)` : ''}</td>
                    <td>{formatMoney(p?.amount_minor ?? o.amount_minor, o.currency)}{p?.refunded_minor ? <div className="cell-sub">refunded {formatMoney(p.refunded_minor, p.currency)}</div> : null}</td>
                    <td><Pill tone={tone(status)}>{status.replace('_', ' ')}</Pill>{o.failure_reason && <div className="cell-sub">{o.failure_reason}</div>}{p && <div className="cell-sub mono">{p.provider_payment_id}</div>}</td>
                    <td style={{ textAlign: 'right' }}>
                      {can('billing.refund') && p && left > 0 && p.status !== 'disputed' && (
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => openDialog({
                          title: 'Refund through Razorpay',
                          message: `Up to ${formatMoney(left, p.currency)}. A full refund ends the plan this payment bought; a partial refund keeps it.`,
                          fields: [
                            { name: 'amount', label: `Amount (${p.currency})`, type: 'number', initial: (left / 100).toFixed(2), minLength: 1 },
                            { name: 'reason', label: 'Reason (recorded)', minLength: 3 },
                          ],
                          confirmLabel: 'Request refund', danger: true,
                          onConfirm: async (v) => {
                            const minor = Math.round(Number(v.amount) * 100);
                            if (!(minor > 0 && minor <= left)) throw new Error('Enter an amount up to what is left to refund.');
                            await api.refund(p.id, v.reason.trim(), minor === left ? undefined : minor);
                            setNotice('Refund requested at Razorpay.');
                            load();
                          },
                        })}>Refund</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-pad card-title">Razorpay webhooks</div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Received</th><th>Event</th><th>Result</th></tr></thead>
            <tbody>
              {hooks.length === 0 && <tr><td colSpan={3} className="empty">No webhooks received yet.</td></tr>}
              {hooks.map((h) => (
                <tr key={h.provider_event_id}>
                  <td>{formatDateTime(h.received_at)}</td>
                  <td><span className="tag">{h.event}</span><div className="cell-sub mono">{h.provider_event_id}</div></td>
                  <td><Pill tone={h.status === 'processed' ? 'ok' : h.status === 'failed' ? 'bad' : 'muted'}>{h.status}</Pill>{h.error && <div className="cell-sub">{h.error}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
