-- Postgres cannot DROP a value from an enum in place, so the type is recreated.
-- Safe: no row has ever held 'OFFER_ACCEPTED' (the value was never emitted —
-- accepting an offer records SALE_CARD, and Offer.status holds the acceptance).

BEGIN;

CREATE TYPE "ActivityType_new" AS ENUM (
  'OFFER_MADE',
  'OFFER_CANCELED',
  'OFFER_REJECTED',
  'SALE_CARD',
  'LISTED_CARD',
  'LISTING_CANCELED',
  'SEND_TO_VAULT',
  'SEND_TO_HOME'
);

ALTER TABLE "activities"
  ALTER COLUMN "type" TYPE "ActivityType_new"
  USING ("type"::text::"ActivityType_new");

ALTER TYPE "ActivityType" RENAME TO "ActivityType_old";
ALTER TYPE "ActivityType_new" RENAME TO "ActivityType";
DROP TYPE "ActivityType_old";

COMMIT;
