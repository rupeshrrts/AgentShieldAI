"""Minimal Razorpay REST client and signature checks.

Only the server talks to Razorpay with the key secret; the browser receives the public key id
and an order/subscription id for Razorpay's hosted Checkout, so card and UPI details never
reach AgentShield. Tests replace `api_request` with a fake (no network, no real payments).

Signatures (Razorpay documentation):
- Checkout result, order:        HMAC_SHA256(order_id + "|" + payment_id, key_secret)
- Checkout result, subscription: HMAC_SHA256(payment_id + "|" + subscription_id, key_secret)
- Webhook:                       HMAC_SHA256(raw request body, webhook_secret) in X-Razorpay-Signature
"""
import hashlib
import hmac
from typing import Any, Optional

import httpx

from app.core.config import settings


class RazorpayError(RuntimeError):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


def _hmac_hex(secret: str, message: bytes) -> str:
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def verify_checkout_order(order_id: str, payment_id: str, signature: str) -> bool:
    if not settings.RAZORPAY_KEY_SECRET or not signature:
        return False
    return hmac.compare_digest(_hmac_hex(settings.RAZORPAY_KEY_SECRET, f"{order_id}|{payment_id}".encode()), signature)


def verify_checkout_subscription(subscription_id: str, payment_id: str, signature: str) -> bool:
    if not settings.RAZORPAY_KEY_SECRET or not signature:
        return False
    return hmac.compare_digest(_hmac_hex(settings.RAZORPAY_KEY_SECRET, f"{payment_id}|{subscription_id}".encode()), signature)


def verify_webhook(raw_body: bytes, signature: Optional[str]) -> bool:
    if not settings.RAZORPAY_WEBHOOK_SECRET or not signature:
        return False
    return hmac.compare_digest(_hmac_hex(settings.RAZORPAY_WEBHOOK_SECRET, raw_body), signature)


def api_request(method: str, path: str, json: Optional[dict] = None) -> Any:
    """Calls the Razorpay API with the server's key. Raises RazorpayError on failure."""
    if not settings.payments_configured:
        raise RazorpayError("Online payments are not configured on this server.", 503)
    try:
        res = httpx.request(
            method, f"{settings.RAZORPAY_API_BASE}{path}", json=json,
            auth=(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET), timeout=20,
        )
    except httpx.HTTPError as exc:
        raise RazorpayError(f"Could not reach Razorpay: {exc.__class__.__name__}") from exc
    if res.status_code >= 400:
        try:
            desc = res.json().get("error", {}).get("description") or res.text[:200]
        except ValueError:
            desc = res.text[:200]
        raise RazorpayError(f"Razorpay refused the request: {desc}", 502)
    return res.json()


# Thin wrappers (each a single documented endpoint)
def create_order(amount_minor: int, currency: str, receipt: str, notes: dict) -> dict:
    return api_request("POST", "/orders", {"amount": amount_minor, "currency": currency, "receipt": receipt, "notes": notes})


def fetch_payment(payment_id: str) -> dict:
    return api_request("GET", f"/payments/{payment_id}")


def capture_payment(payment_id: str, amount_minor: int, currency: str) -> dict:
    return api_request("POST", f"/payments/{payment_id}/capture", {"amount": amount_minor, "currency": currency})


def order_payments(order_id: str) -> list:
    return api_request("GET", f"/orders/{order_id}/payments").get("items", [])


def create_plan(name: str, amount_minor: int, currency: str, period: str = "monthly", interval: int = 1) -> dict:
    return api_request("POST", "/plans", {"period": period, "interval": interval, "item": {"name": name, "amount": amount_minor, "currency": currency}})


def create_subscription(plan_id: str, total_count: int, notes: dict) -> dict:
    return api_request("POST", "/subscriptions", {"plan_id": plan_id, "total_count": total_count, "customer_notify": 1, "notes": notes})


def cancel_subscription(subscription_id: str, at_cycle_end: bool = True) -> dict:
    return api_request("POST", f"/subscriptions/{subscription_id}/cancel", {"cancel_at_cycle_end": 1 if at_cycle_end else 0})


def refund_payment(payment_id: str, amount_minor: Optional[int], notes: dict) -> dict:
    body: dict = {"notes": notes}
    if amount_minor:
        body["amount"] = amount_minor
    return api_request("POST", f"/payments/{payment_id}/refund", body)
