ALTER TABLE stores ADD CONSTRAINT store_sms_limits CHECK (sms_hour BETWEEN 0 AND 23 AND sms_minute BETWEEN 0 AND 59 AND daily_cap BETWEEN 0 AND 10000 AND sms_cost_cap >= 0 AND sms_unit_cost >= 0);--> statement-breakpoint
ALTER TABLE stores ADD CONSTRAINT store_trial_period CHECK (trial_ends_at > trial_started_at);--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT user_role CHECK (role IN ('admin','employee'));--> statement-breakpoint
ALTER TABLE customers ADD CONSTRAINT customer_phone CHECK (phone ~ '^998[0-9]{9}$');--> statement-breakpoint
CREATE UNIQUE INDEX customer_phone_active ON customers(store_id,phone) WHERE archived_at IS NULL;--> statement-breakpoint
ALTER TABLE debt_items ADD CONSTRAINT debt_item_amount CHECK (quantity > 0 AND unit_price > 0 AND line_total > 0 AND line_total::bigint = quantity::bigint * unit_price::bigint);--> statement-breakpoint
ALTER TABLE debts ADD CONSTRAINT debt_amount CHECK (total > 0);--> statement-breakpoint
ALTER TABLE payments ADD CONSTRAINT payment_amount CHECK (amount > 0);--> statement-breakpoint
ALTER TABLE allocations ADD CONSTRAINT allocation_amount CHECK (amount > 0);--> statement-breakpoint
ALTER TABLE sms_outbox ADD CONSTRAINT sms_status CHECK (status IN ('pending','retry','processing','accepted','transmitted','delivered','unknown','failed','cancelled','not_delivered','rejected','failed_delivery','expired') AND attempts >= 0);--> statement-breakpoint
CREATE UNIQUE INDEX sms_provider_message_unique ON sms_outbox(provider_message_id) WHERE provider_message_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE subscription_attempts ADD CONSTRAINT subscription_plan CHECK ((plan_months = 1 AND amount_uzs = 60000) OR (plan_months = 2 AND amount_uzs = 100000));