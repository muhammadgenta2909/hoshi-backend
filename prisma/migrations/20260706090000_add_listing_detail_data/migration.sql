-- Persist card-detail data on marketplace listings so the detail endpoint does
-- not synthesize certificate/location/history/offers at request time.

ALTER TABLE "listings" ADD COLUMN "imageBack" TEXT;
ALTER TABLE "listings" ADD COLUMN "certificate" TEXT;
ALTER TABLE "listings" ADD COLUMN "vaultLocation" TEXT;
ALTER TABLE "listings" ADD COLUMN "cardNumber" TEXT;
ALTER TABLE "listings" ADD COLUMN "variant" TEXT;
ALTER TABLE "listings" ADD COLUMN "contractAddress" TEXT;
ALTER TABLE "listings" ADD COLUMN "priceHistory" JSONB;
ALTER TABLE "listings" ADD COLUMN "offers" JSONB;

UPDATE "listings"
SET
  "imageBack" = COALESCE("imageBack", '/card-back.svg'),
  "certificate" = COALESCE(
    "certificate",
    CONCAT(
      1000 + (
        ASCII(SUBSTR(MD5("id" || ':cert-a'), 1, 1)) * 97 +
        ASCII(SUBSTR(MD5("id" || ':cert-a'), 2, 1)) * 53 +
        ASCII(SUBSTR(MD5("id" || ':cert-a'), 3, 1)) * 31
      ) % 9000,
      ' ',
      1000 + (
        ASCII(SUBSTR(MD5("id" || ':cert-b'), 1, 1)) * 89 +
        ASCII(SUBSTR(MD5("id" || ':cert-b'), 2, 1)) * 47 +
        ASCII(SUBSTR(MD5("id" || ':cert-b'), 3, 1)) * 29
      ) % 9000
    )
  ),
  "vaultLocation" = COALESCE(
    "vaultLocation",
    CASE
      WHEN "element" IN ('Fire', 'Lightning') THEN 'Jakarta Vault A'
      WHEN "element" IN ('Water', 'Grass') THEN 'Jakarta Vault B'
      ELSE 'Jakarta Vault C'
    END
  ),
  "cardNumber" = COALESCE(
    "cardNumber",
    CONCAT(
      1 + (
        ASCII(SUBSTR(MD5("id" || ':card-no'), 1, 1)) * 97 +
        ASCII(SUBSTR(MD5("id" || ':card-no'), 2, 1)) * 53
      ) % 180,
      '/',
      180
    )
  ),
  "variant" = COALESCE(
    "variant",
    CASE
      WHEN "category" = 'Rainbow' THEN 'Rainbow Foil'
      WHEN "category" = 'Full Art' THEN 'Full Art'
      WHEN "category" = 'PROMO CARD' THEN 'Promo'
      ELSE 'Holo'
    END
  ),
  "priceHistory" = COALESCE(
    "priceHistory",
    JSONB_BUILD_ARRAY(
      GREATEST(1, ROUND("priceIdrx" * 0.91)::INT),
      GREATEST(1, ROUND("priceIdrx" * 0.94)::INT),
      GREATEST(1, ROUND("priceIdrx" * 0.93)::INT),
      GREATEST(1, ROUND("priceIdrx" * 0.97)::INT),
      GREATEST(1, ROUND("priceIdrx" * 0.99)::INT),
      "priceIdrx"
    )
  ),
  "offers" = COALESCE("offers", '[]'::JSONB);
