CREATE TABLE "attestation_bundles" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key_id" "bytea" NOT NULL,
	"stamp_id" "bytea",
	"kind" text NOT NULL,
	"platform" text NOT NULL,
	"sha256" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attestation_bundles_kind_chk" CHECK ("attestation_bundles"."kind" in ('enrol','capture'))
);
--> statement-breakpoint
CREATE TABLE "bindings" (
	"stamp_id" "bytea" NOT NULL,
	"slot" smallint NOT NULL,
	"asset" smallint NOT NULL,
	"data_set_id" bigint,
	"piece_id" bigint,
	"provider_id" bigint,
	"service_url" text,
	"bind_tx" "bytea",
	"bound_epoch" bigint,
	"last_probe_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"probe_failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "bindings_stamp_id_slot_pk" PRIMARY KEY("stamp_id","slot")
);
--> statement-breakpoint
CREATE TABLE "captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" "bytea" NOT NULL,
	"user_id" uuid,
	"media_kind" smallint NOT NULL,
	"challenge_id" uuid,
	"expected_size" bigint,
	"status" text DEFAULT 'open' NOT NULL,
	"stamp_id" "bytea",
	"predicted_code" bigint,
	"reissued_capture_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "captures_status_chk" CHECK ("captures"."status" in ('open','uploaded','claimed','rejected','expired','reissued'))
);
--> statement-breakpoint
CREATE TABLE "chain_txs" (
	"hash" "bytea" PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"stamp_id" "bytea",
	"sender" "bytea",
	"nonce" bigint,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"included_epoch" bigint,
	"safe_at" timestamp with time zone,
	"final_at" timestamp with time zone,
	"status" text DEFAULT 'submitted' NOT NULL,
	"error" text,
	CONSTRAINT "chain_txs_status_chk" CHECK ("chain_txs"."status" in ('submitted','included','safe','final','failed','replaced','dropped'))
);
--> statement-breakpoint
CREATE TABLE "challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"value" "bytea" NOT NULL,
	"key_id" "bytea",
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "data_sets" (
	"data_set_id" bigint PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"provider_id" bigint,
	"with_cdn" boolean,
	"last_proven_epoch" bigint,
	"proving_deadline" bigint,
	"faults" integer DEFAULT 0 NOT NULL,
	"pdp_end_epoch" bigint,
	"reserve" numeric,
	"checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "derivatives" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"stamp_id" "bytea" NOT NULL,
	"kind" smallint NOT NULL,
	"sha256" "bytea" NOT NULL,
	"piece_cid" "bytea",
	"params" jsonb,
	"params_hash" "bytea",
	"path" text,
	"attach_tx" "bytea",
	CONSTRAINT "derivatives_sha256_unique" UNIQUE("sha256")
);
--> statement-breakpoint
CREATE TABLE "device_keys" (
	"key_id" "bytea" PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"platform" text NOT NULL,
	"key_type" smallint NOT NULL,
	"level" smallint NOT NULL,
	"addr" "bytea",
	"pub_x" "bytea",
	"pub_y" "bytea",
	"rp_id_hash" "bytea",
	"attestation_hash" "bytea",
	"attestation_enc" "bytea",
	"app_attest_key_id" text,
	"assertion_counter" bigint DEFAULT 0 NOT NULL,
	"risk_metric" integer,
	"play_verdict" jsonb,
	"registered_tx" "bytea",
	"registered_epoch" bigint,
	"expires_at" timestamp with time zone,
	"revoked_epoch" bigint,
	"revoke_reason" smallint,
	"next_nonce" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_keys_platform_chk" CHECK ("device_keys"."platform" in ('ios','android','web'))
);
--> statement-breakpoint
CREATE TABLE "moderation" (
	"stamp_id" "bytea" PRIMARY KEY NOT NULL,
	"checks" jsonb,
	"decision" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"reason_uri" text
);
--> statement-breakpoint
CREATE TABLE "renditions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"stamp_id" "bytea" NOT NULL,
	"derivative_id" bigint,
	"variant" smallint NOT NULL,
	"pdq" bit(256) NOT NULL,
	"pdq_quality" integer,
	CONSTRAINT "renditions_variant_chk" CHECK ("renditions"."variant" between 0 and 9)
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stamp_id" "bytea",
	"kind" text NOT NULL,
	"reporter" text,
	"status" text DEFAULT 'open' NOT NULL,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stamp_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"stamp_id" "bytea",
	"kind" text NOT NULL,
	"actor" text NOT NULL,
	"data" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stamps" (
	"stamp_id" "bytea" PRIMARY KEY NOT NULL,
	"code" bigint,
	"user_id" uuid,
	"key_id" "bytea",
	"media_kind" smallint,
	"mime" text,
	"size" bigint,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"content_sha256" "bytea",
	"piece_cid" "bytea",
	"record_cbor" "bytea",
	"private_record_enc" "bytea",
	"claim" jsonb,
	"sig" "bytea",
	"auth_data" "bytea",
	"countersig" "bytea",
	"captured_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"registered_epoch" bigint,
	"register_tx" "bytea",
	"status" text DEFAULT 'received' NOT NULL,
	"finality" text DEFAULT 'pending' NOT NULL,
	"level" smallint,
	"flags" smallint DEFAULT 0 NOT NULL,
	"ingest" jsonb,
	CONSTRAINT "stamps_code_unique" UNIQUE("code"),
	CONSTRAINT "stamps_content_sha256_unique" UNIQUE("content_sha256"),
	CONSTRAINT "stamps_status_chk" CHECK ("stamps"."status" in ('received','registering','registered','rejected','marked','stored','withdrawn','takedown')),
	CONSTRAINT "stamps_finality_chk" CHECK ("stamps"."finality" in ('pending','included','safe','final'))
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"capture_id" uuid NOT NULL,
	"total_size" bigint,
	"received" bigint DEFAULT 0 NOT NULL,
	"path" text NOT NULL,
	"sha256" "bytea",
	"piece_cid" "bytea",
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "uploads_status_chk" CHECK ("uploads"."status" in ('open','complete','aborted')),
	CONSTRAINT "uploads_received_chk" CHECK ("uploads"."received" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handle" text,
	"tier" text DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"stamp_id" "bytea",
	"method" text NOT NULL,
	"distance" integer,
	"verdict" text NOT NULL,
	"ip_hash" "bytea",
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verify_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"path" text NOT NULL,
	"mime" text,
	"size" bigint,
	"ip_hash" "bytea",
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "verify_jobs_status_chk" CHECK ("verify_jobs"."status" in ('queued','running','done','failed'))
);
--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_key_id_device_keys_key_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."device_keys"("key_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_challenge_id_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derivatives" ADD CONSTRAINT "derivatives_stamp_id_stamps_stamp_id_fk" FOREIGN KEY ("stamp_id") REFERENCES "public"."stamps"("stamp_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_keys" ADD CONSTRAINT "device_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stamps" ADD CONSTRAINT "stamps_key_id_device_keys_key_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."device_keys"("key_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attestation_bundles_key_idx" ON "attestation_bundles" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "captures_key_idx" ON "captures" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "captures_stamp_idx" ON "captures" USING btree ("stamp_id");--> statement-breakpoint
CREATE INDEX "chain_txs_status_idx" ON "chain_txs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "chain_txs_stamp_idx" ON "chain_txs" USING btree ("stamp_id");--> statement-breakpoint
CREATE INDEX "challenges_expires_idx" ON "challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "derivatives_stamp_idx" ON "derivatives" USING btree ("stamp_id");--> statement-breakpoint
CREATE INDEX "device_keys_user_idx" ON "device_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "renditions_pdq_hnsw" ON "renditions" USING hnsw ("pdq" bit_hamming_ops);--> statement-breakpoint
CREATE INDEX "renditions_stamp_idx" ON "renditions" USING btree ("stamp_id");--> statement-breakpoint
CREATE INDEX "stamp_events_stamp_idx" ON "stamp_events" USING btree ("stamp_id","at");--> statement-breakpoint
CREATE INDEX "stamps_status_idx" ON "stamps" USING btree ("status");--> statement-breakpoint
CREATE INDEX "uploads_capture_idx" ON "uploads" USING btree ("capture_id");--> statement-breakpoint
CREATE INDEX "verifications_stamp_idx" ON "verifications" USING btree ("stamp_id");--> statement-breakpoint
CREATE INDEX "verify_jobs_created_idx" ON "verify_jobs" USING btree ("created_at");