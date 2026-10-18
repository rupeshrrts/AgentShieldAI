import { api } from './api';
import { CheckoutSession } from '../types';

/**
 * Razorpay hosted Checkout. Card/UPI details go straight to Razorpay; the portal only receives
 * payment ids and a signature, which the server verifies (and re-fetches from Razorpay) before
 * any plan is activated. The webhook completes the payment too if this tab is closed early.
 */
const SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';

declare global {
  interface Window {
    Razorpay?: any;
  }
}

let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SCRIPT_URL;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        loading = null;
        reject(new Error('Could not load Razorpay Checkout. Check your connection and try again.'));
      };
      document.head.appendChild(s);
    });
  }
  return loading;
}

export type CheckoutOutcome =
  | { status: 'paid'; receipt_number?: string }
  | { status: 'pending'; message?: string }
  | { status: 'dismissed' }
  | { status: 'failed'; message: string };

export async function payForPlan(planCode: string): Promise<CheckoutOutcome> {
  const session: CheckoutSession = await api.startCheckout(planCode);
  await loadScript();
  return new Promise((resolve) => {
    let settled = false;
    let lastError = '';
    const finish = (o: CheckoutOutcome) => {
      if (!settled) {
        settled = true;
        resolve(o);
      }
    };
    const rzp = new window.Razorpay({
      key: session.key_id,
      name: session.name,
      description: session.description,
      ...(session.mode === 'order' ? { order_id: session.order_id, amount: session.amount, currency: session.currency } : { subscription_id: session.subscription_id }),
      prefill: session.prefill,
      theme: { color: '#2563eb' },
      handler: async (result: Record<string, string>) => {
        try {
          finish(await api.confirmCheckout(result));
        } catch (e: any) {
          finish({ status: 'pending', message: `${e.message}. If money was taken, your plan activates once Razorpay confirms it.` });
        }
      },
      modal: { ondismiss: () => finish(lastError ? { status: 'failed', message: lastError } : { status: 'dismissed' }) },
    });
    // The customer can retry inside the Checkout window, so a failure only matters if they then close it
    rzp.on('payment.failed', (r: any) => {
      lastError = r?.error?.description || 'The payment failed.';
    });
    rzp.open();
  });
}
