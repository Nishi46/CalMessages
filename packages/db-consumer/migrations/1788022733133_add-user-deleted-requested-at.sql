-- Up Migration
ALTER TABLE "user" ADD COLUMN deleted_requested_at TIMESTAMPTZ;

-- Down Migration
ALTER TABLE "user" DROP COLUMN IF EXISTS deleted_requested_at;
