CREATE TABLE "applicants" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"tier" smallint,
	"jurisdiction" smallint,
	"kyc_expiry" timestamp with time zone,
	"lockup_until" timestamp with time zone,
	"reviewed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"event" text NOT NULL,
	"subject" text,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "link_challenges" (
	"nonce" text PRIMARY KEY NOT NULL,
	"applicant_id" text NOT NULL,
	"wallet" text NOT NULL,
	"message" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "onchain_jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text,
	"signature" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"address" text PRIMARY KEY NOT NULL,
	"applicant_id" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_provider_event_id_pk" PRIMARY KEY("provider","event_id")
);
--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_applicant_id_applicants_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."applicants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "onchain_jobs_one_pending_per_wallet" ON "onchain_jobs" USING btree ("wallet") WHERE "onchain_jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "onchain_jobs_due_idx" ON "onchain_jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "wallets_applicant_idx" ON "wallets" USING btree ("applicant_id");