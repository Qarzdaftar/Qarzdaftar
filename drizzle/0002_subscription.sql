ALTER TABLE stores ADD COLUMN cancelled_at timestamptz;--> statement-breakpoint
ALTER TABLE subscription_attempts ADD COLUMN provider text NOT NULL DEFAULT 'payme';--> statement-breakpoint
ALTER TABLE subscription_attempts ADD COLUMN idempotency_key text;--> statement-breakpoint
UPDATE subscription_attempts SET idempotency_key=id::text WHERE idempotency_key IS NULL;--> statement-breakpoint
ALTER TABLE subscription_attempts ALTER COLUMN idempotency_key SET NOT NULL;--> statement-breakpoint
ALTER TABLE subscription_attempts ADD COLUMN provider_transaction_id text;--> statement-breakpoint
ALTER TABLE subscription_attempts ADD COLUMN provider_created_at timestamptz;--> statement-breakpoint
ALTER TABLE subscription_attempts ADD COLUMN performed_at timestamptz;--> statement-breakpoint
ALTER TABLE subscription_attempts ADD COLUMN cancelled_at timestamptz;--> statement-breakpoint
ALTER TABLE subscription_attempts ADD COLUMN cancel_reason integer;--> statement-breakpoint
ALTER TABLE subscription_attempts ADD COLUMN period_start timestamptz;--> statement-breakpoint
ALTER TABLE subscription_attempts ADD COLUMN period_end timestamptz;--> statement-breakpoint
CREATE UNIQUE INDEX subscription_initiation_once ON subscription_attempts(store_id,idempotency_key);--> statement-breakpoint
CREATE UNIQUE INDEX subscription_provider_transaction_once ON subscription_attempts(provider_transaction_id) WHERE provider_transaction_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE subscription_attempts ADD CONSTRAINT subscription_attempt_state CHECK (status IN ('pending','created','paid','cancelled','failed'));--> statement-breakpoint
ALTER TABLE subscription_attempts ADD CONSTRAINT subscription_provider CHECK (provider='payme');--> statement-breakpoint
ALTER TABLE subscription_attempts ADD CONSTRAINT subscription_period CHECK ((status='paid' AND period_start IS NOT NULL AND period_end>period_start AND performed_at IS NOT NULL) OR status<>'paid');--> statement-breakpoint
ALTER TABLE stores ADD CONSTRAINT paid_until_after_trial_start CHECK (paid_until IS NULL OR paid_until>trial_started_at);