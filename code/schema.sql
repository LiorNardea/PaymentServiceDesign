-- Schema matching design/data-model.md

CREATE TABLE IF NOT EXISTS payments (
  id                    TEXT PRIMARY KEY,
  consumer_id           TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL,
  customer_id           TEXT NOT NULL,
  amount                INTEGER NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'usd',
  description           TEXT,
  metadata              JSONB,
  status                TEXT NOT NULL,
  stripe_pi_id          TEXT,
  failure_reason        TEXT,
  parent_payment_id     TEXT REFERENCES payments(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (consumer_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_payments_status_updated ON payments (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_pi ON payments (stripe_pi_id);

CREATE TABLE IF NOT EXISTS payment_events (
  id          TEXT PRIMARY KEY,
  payment_id  TEXT NOT NULL REFERENCES payments(id),
  event_type  TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_payment_created ON payment_events (payment_id, created_at);

CREATE TABLE IF NOT EXISTS outbox (
  id          TEXT PRIMARY KEY,
  payment_id  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  enqueued_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbox_unenqueued ON outbox (enqueued_at) WHERE enqueued_at IS NULL;

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  stripe_event_id  TEXT PRIMARY KEY,
  event_type       TEXT NOT NULL,
  processed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_payment_methods (
  id                    TEXT PRIMARY KEY,
  customer_id           TEXT NOT NULL,
  stripe_customer_id    TEXT NOT NULL,
  stripe_pm_id          TEXT NOT NULL,
  is_default            BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cpm_customer ON customer_payment_methods (customer_id);
