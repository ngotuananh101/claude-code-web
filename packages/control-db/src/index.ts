/**
 * Control database schema, migrations and repository interfaces.
 *
 * SQLite + Drizzle for the single-instance MVP; PostgreSQL is a later upgrade
 * behind the same repository interface (§18.4).
 */

export { migrate } from "./db.ts";
export {
  createEnrollment,
  consumeEnrollment,
  type CreatedEnrollment,
  type ConsumedEnrollment,
} from "./enrollment.ts";
