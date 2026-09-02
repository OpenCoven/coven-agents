CREATE TABLE "StripeReconciliationRun" (
	"cursor" uuid,
	"id" integer PRIMARY KEY NOT NULL,
	"leaseExpiresAt" timestamp,
	"leaseFence" integer DEFAULT 0 NOT NULL,
	"leaseOwner" varchar(64),
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "StripeReconciliationRun_singleton" CHECK ("StripeReconciliationRun"."id" = 1),
	CONSTRAINT "StripeReconciliationRun_fence_nonnegative" CHECK ("StripeReconciliationRun"."leaseFence" >= 0),
	CONSTRAINT "StripeReconciliationRun_lease_shape" CHECK (("StripeReconciliationRun"."leaseOwner" is null and "StripeReconciliationRun"."leaseExpiresAt" is null) or ("StripeReconciliationRun"."leaseOwner" is not null and "StripeReconciliationRun"."leaseExpiresAt" is not null))
);
