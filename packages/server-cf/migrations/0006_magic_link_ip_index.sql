-- Migration number: 0006
-- Partial index supporting the per-IP rate-limit query on
-- magic_link_tokens (ADR 0010 — per-IP 20/hour). Lives separately
-- from 0005 so existing local DBs can pick it up via the standard
-- migration path.
--
-- WHERE request_ip IS NOT NULL keeps the index lean: rows whose IP
-- wasn't captured (older inserts, request with no CF-Connecting-IP
-- header) don't participate in the IP-bucket check anyway.

CREATE INDEX IF NOT EXISTS idx_magic__by_ip_time
    ON magic_link_tokens(request_ip, time_created)
    WHERE request_ip IS NOT NULL;
