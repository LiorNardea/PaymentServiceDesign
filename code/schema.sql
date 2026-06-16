-- Schema matching design/data-model.md (MySQL dialect)

CREATE DATABASE IF NOT EXISTS payment_service;
USE payment_service;

CREATE TABLE IF NOT EXISTS payments (
  id                    VARCHAR(64) PRIMARY KEY,
  consumer_id           VARCHAR(128) NOT NULL,
  idempotency_key       VARCHAR(255) NOT NULL,
  customer_id           VARCHAR(128) NOT NULL,
  amount                INT NOT NULL,
  currency              VARCHAR(8) NOT NULL DEFAULT 'usd',
  description           TEXT,
  metadata              JSON,
  status                VARCHAR(32) NOT NULL,
  stripe_pi_id          VARCHAR(128),
  failure_reason        TEXT,
  parent_payment_id     VARCHAR(64),
  created_at            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uq_consumer_idempotency (consumer_id, idempotency_key),
  KEY idx_status_updated (status, updated_at),
  KEY idx_stripe_pi (stripe_pi_id),
  FOREIGN KEY (parent_payment_id) REFERENCES payments(id)
);

CREATE TABLE IF NOT EXISTS payment_events (
  id          VARCHAR(64) PRIMARY KEY,
  payment_id  VARCHAR(64) NOT NULL,
  event_type  VARCHAR(64) NOT NULL,
  from_status VARCHAR(32),
  to_status   VARCHAR(32),
  payload     JSON,
  created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  KEY idx_payment_created (payment_id, created_at),
  FOREIGN KEY (payment_id) REFERENCES payments(id)
);

CREATE TABLE IF NOT EXISTS outbox (
  id          VARCHAR(64) PRIMARY KEY,
  payment_id  VARCHAR(64) NOT NULL,
  payload     JSON NOT NULL,
  enqueued_at TIMESTAMP(3) NULL,
  created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  KEY idx_unenqueued (enqueued_at)
);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  stripe_event_id  VARCHAR(128) PRIMARY KEY,
  event_type       VARCHAR(64) NOT NULL,
  processed_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS customer_payment_methods (
  id                    VARCHAR(64) PRIMARY KEY,
  customer_id           VARCHAR(128) NOT NULL,
  stripe_customer_id    VARCHAR(128) NOT NULL,
  stripe_pm_id          VARCHAR(128) NOT NULL,
  is_default            BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  KEY idx_customer (customer_id)
);
