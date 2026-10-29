/**
 * First-time setup validation rules (§19.1, Task 3).
 *
 * Pure rules shared between the setup form and its controller so the logic is
 * testable without a DOM:
 * - Username cannot be empty after trimming.
 * - Password must be at least 6 characters.
 * - Confirm password must match password.
 *
 * Error copy is Vietnamese, matching the rest of the UI. The server enforces
 * the same shape (it trims the username and rejects empty values with 400), but
 * surfacing the rules here gives instant, localized feedback before a request
 * is ever sent.
 */

/** A single result from validating the setup form. */
export type SetupFormResult =
  | { valid: true; error?: undefined }
  | { valid: false; error: string };

/** The fields a first-time-setup form collects. */
export interface SetupFormData {
  username: string;
  password: string;
  confirmPassword: string;
}

/** Vietnamese copy for each rule, in the order the checks run. */
const ERROR_USERNAME_EMPTY = "Tên đăng nhập không được để trống.";
const ERROR_PASSWORD_SHORT = "Mật khẩu phải có ít nhất 6 ký tự.";
const ERROR_PASSWORD_MISMATCH = "Mật khẩu xác nhận không khớp.";

/**
 * Validate the setup form fields in priority order: username, then password
 * length, then password confirmation. The first failing rule wins so the
 * operator reads one message at a time. A form that trims to a valid username,
 * reaches the password floor, and matches confirmation answers `{ valid: true }`
 * — the caller may submit the trimmed username to `submitSetup`.
 */
export function validateSetupForm(form: SetupFormData): SetupFormResult {
  if (form.username.trim() === "") {
    return { valid: false, error: ERROR_USERNAME_EMPTY };
  }

  if (form.password.length < 6) {
    return { valid: false, error: ERROR_PASSWORD_SHORT };
  }

  if (form.confirmPassword !== form.password) {
    return { valid: false, error: ERROR_PASSWORD_MISMATCH };
  }

  return { valid: true };
}
