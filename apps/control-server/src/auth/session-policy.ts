/**
 * Owner session lifetime constants (ADR-0001, §19.1).
 *
 * Centralized here so the JWT signer/service and the HTTP cookie issuers share
 * one source of truth for access, default/session refresh, and 30-day
 * remembered refresh lifetimes.
 */

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
export const REMEMBERED_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
