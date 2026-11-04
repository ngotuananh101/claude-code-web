import { t } from "@/lib/i18n";

/**
 * First-time setup validation rules (§19.1, Task 3).
 *
 * Pure rules shared between the setup form and its controller so the logic is
 * testable without a DOM:
 * - Username cannot be empty after trimming.
 * - Password must be at least 6 characters.
 * - Confirm password must match password.
 *
 * Error copy is localized, matching the rest of the UI. The server enforces
 * the same shape (it trims the username and rejects empty values with 400), but
 * surfacing the rules here gives instant, localized feedback before a request
 * is ever sent.
 */

/** A single result from validating the setup form. */
export type SetupFormResult = { valid: true; error?: undefined } | { valid: false; error: string };

/** The fields a first-time-setup form collects. */
export interface SetupFormData {
  username: string;
  password: string;
  confirmPassword: string;
}

/** Vietnamese copy for each rule, in the order the checks run. */
const errorUsernameEmpty = (): string => t("auth.setupUsernameEmpty");
const errorPasswordShort = (): string => t("auth.setupPasswordShort");
const errorPasswordMismatch = (): string => t("auth.setupPasswordMismatch");

/**
 * Validate the setup form fields in priority order: username, then password
 * length, then password confirmation. The first failing rule wins so the
 * operator reads one message at a time. A form that trims to a valid username,
 * reaches the password floor, and matches confirmation answers `{ valid: true }`
 * — the caller may submit the trimmed username to `submitSetup`.
 */
export function validateSetupForm(form: SetupFormData): SetupFormResult {
  if (form.username.trim() === "") {
    return { valid: false, error: errorUsernameEmpty() };
  }

  if (form.password.length < 6) {
    return { valid: false, error: errorPasswordShort() };
  }

  if (form.confirmPassword !== form.password) {
    return { valid: false, error: errorPasswordMismatch() };
  }

  return { valid: true };
}
