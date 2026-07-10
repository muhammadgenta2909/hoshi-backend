-- Snapshot the card's series on the activity row so the "All Series" filter
-- works even if the listing is later deleted (listingId is ON DELETE SET NULL).
ALTER TABLE "activities" ADD COLUMN "set" TEXT;
