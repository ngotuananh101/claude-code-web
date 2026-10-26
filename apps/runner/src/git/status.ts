/**
 * `git status --porcelain=v1 -z` into typed change entries (§15.2).
 *
 * `-z` is not a style choice: it is what makes the parse unambiguous. In the
 * default form a path with a space, a quote or a newline is quoted and escaped,
 * and a rename carries its original path inline after an arrow — a string a
 * path can itself contain, so the split is a guess. NUL-separated output has no
 * such ambiguity: a record ends where the separator is, and a rename's original
 * path is simply the next field.
 *
 * Nothing is inferred. A record whose XY code is not one this module knows is
 * dropped rather than defaulted to `modified`: a change list that invents a
 * status is worse than one that omits an entry, because the omission is visible
 * and the invention is not.
 */

import { type ChangeStatus, MAX_CHANGE_ENTRIES } from "@cc-web/protocol";

export type ChangeEntry = { path: string; status: ChangeStatus; origPath?: string };

export type PorcelainChanges = { entries: ChangeEntry[]; truncated: boolean };

/**
 * Parse porcelain v1 output (NUL-terminated records) into bounded entries.
 *
 * `origPath` is consumed as a separate field for `R` and `C` only; for every
 * other status the field after a record is the next record's.
 */
export function parsePorcelainStatus(
  stdout: string,
  limit: number = MAX_CHANGE_ENTRIES,
): PorcelainChanges {
  const entries: ChangeEntry[] = [];
  if (stdout === "") return { entries, truncated: false };

  const fields = stdout.split("\0");
  // A trailing NUL leaves one empty field; dropping it here keeps the loop from
  // reading it as a record.
  if (fields[fields.length - 1] === "") fields.pop();

  let truncated = false;
  for (let index = 0; index < fields.length; index += 1) {
    if (entries.length >= limit) {
      truncated = true;
      break;
    }

    const field = fields[index] ?? "";
    // A record is at least "XY path": two status characters, a space, a name.
    if (field.length < 4) continue;
    const x = field[0] ?? "";
    const y = field[1] ?? "";
    const path = field.slice(3);
    if (path === "") continue;

    const status = statusFor(x, y);
    if (status === undefined) continue;

    if (status === "renamed" || status === "copied") {
      const orig = fields[index + 1];
      // The original path is the next field. Consume it either way so a rename
      // never has its origPath read as another record's status code.
      index += 1;
      if (orig === undefined || orig === "") continue;
      entries.push({ path, status, origPath: orig });
      continue;
    }

    entries.push({ path, status });
  }

  return { entries, truncated };
}

/**
 * The two-column XY code into one status.
 *
 * A code containing `U` is a conflict whatever else it says — `UU`, `AA`, `DD`
 * are the unmerged combinations. `??` is untracked. Otherwise the first column
 * (the index side) is the change being described, and a blank index column
 * means the change is only in the working tree, so the second column answers.
 */
function statusFor(x: string, y: string): ChangeStatus | undefined {
  if (x === "?" && y === "?") return "untracked";
  if (x === "U" || y === "U") return "conflicted";

  const letter = x !== " " && x !== "" ? x : y;
  switch (letter) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typechange";
    default:
      return undefined;
  }
}
