-- ==============================================================================
-- AgentShield 1.5 - SaaS phase 2: Razorpay payments, orders, subscriptions,
-- refunds/disputes and webhook idempotency.
--
-- Run once in the Supabase SQL Editor AFTER 2026_10_saas_phase1.sql.
-- Safe to run more than once. The backend also creates these tables on startup.
-- No card or UPI details are stored: Razorpay's hosted Checkout collects them.
-- ==============================================================================

ALTER TABLE plans ADD COLUMN IF NOT EXISTS razorpay_plan_id VARCHAR(60);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS razorpay_plan_amount INTEGER;

-- Purchase attempts; "paid" only after Razorpay confirms the payment
CREATE TABLE IF NOT EXISTS billing_orders (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id VARCHAR(36),
    plan_code VARCHAR(30) NOT NULL,
    kind VARCHAR(15) NOT NULL,
    amount_minor INTEGER NOT NULL,
    currency VARCHAR(3) NOT NULL,
    provider VARCHAR(20) NOT NULL DEFAULT 'razorpay',
    provider_order_id VARCHAR(60) UNIQUE,
    provider_subscription_id VARCHAR(60),
    status VARCHAR(20) NOT NULL DEFAULT 'created',
    failure_reason VARCHAR(255),
    receipt_number VARCHAR(30) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    paid_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_billing_orders_org ON billing_orders(organization_id);
CREATE INDEX IF NOT EXISTS ix_billing_orders_sub ON billing_orders(provider_subscription_id);
CREATE INDEX IF NOT EXISTS ix_billing_orders_created ON billing_orders(created_at);

-- Captured payments (UNIQUE provider_payment_id: one payment grants one licence)
CREATE TABLE IF NOT EXISTS billing_payments (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    order_id VARCHAR(36) REFERENCES billing_orders(id) ON DELETE SET NULL,
    provider_payment_id VARCHAR(60) NOT NULL UNIQUE,
    amount_minor INTEGER NOT NULL,
    currency VARCHAR(3) NOT NULL,
    method VARCHAR(30),
    status VARCHAR(20) NOT NULL DEFAULT 'captured',
    refunded_minor INTEGER NOT NULL DEFAULT 0,
    license_id VARCHAR(36),
    receipt_number VARCHAR(30) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_billing_payments_org ON billing_payments(organization_id);
CREATE INDEX IF NOT EXISTS ix_billing_payments_order ON billing_payments(order_id);

-- Monthly recurring subscriptions
CREATE TABLE IF NOT EXISTS billing_subscriptions (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    plan_code VARCHAR(30) NOT NULL,
    provider_subscription_id VARCHAR(60) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'created',
    cancel_at_period_end BOOLEAN DEFAULT FALSE,
    current_end TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_billing_subscriptions_org ON billing_subscriptions(organization_id);

-- Every webhook received (UNIQUE event id: each event is applied once)
CREATE TABLE IF NOT EXISTS webhook_events (
    id VARCHAR(36) PRIMARY KEY,
    provider VARCHAR(20) NOT NULL DEFAULT 'razorpay',
    provider_event_id VARCHAR(80) NOT NULL UNIQUE,
    event VARCHAR(60) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'received',
    error VARCHAR(500),
    received_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS ix_webhook_events_received ON webhook_events(received_at);

ALTER TABLE billing_orders        ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_payments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events        ENABLE ROW LEVEL SECURITY;
