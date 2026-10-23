import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Runner identity persistence (§6.1, §6.3).
 *
 * The credential is written with mode 0600 and never created world-readable,
 * not even for an instant: we write a temp file that is created with the final
 * mode and then rename it into place. A rename is atomic on the same filesystem,
 * so a reader either sees no file or sees the complete, private file.
 */

export type RunnerIdentity = {
  runnerId: string;
  controlUrl: string;
  /** Bearer credential issued at enrollment. Never logged. */
  credential: string;
};

export type LoadResult =
  | { ok: true; identity: RunnerIdentity }
  | { ok: false; reason: "missing" | "malformed" };

const FILE = "identity.json";
const TMP = "identity.json.tmp";

export async function saveIdentity(dir: string, identity: RunnerIdentity): Promise<void> {
  const target = join(dir, FILE);
  const temp = join(dir, TMP);

  // `mode` on writeFile only applies when the file is created; an existing file
  // keeps its mode. So the temp file is removed first and created fresh.
  await rm(temp, { force: true });
  await writeFile(temp, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  // Belt and braces: an inherited umask could widen the mode at creation.
  await chmod(temp, 0o600);

  await rename(temp, target);
}

export async function loadIdentity(dir: string): Promise<LoadResult> {
  let raw: string;
  try {
    raw = await readFile(join(dir, FILE), "utf8");
  } catch {
    return { ok: false, reason: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (!isRunnerIdentity(parsed)) return { ok: false, reason: "malformed" };
  return { ok: true, identity: parsed };
}

function isRunnerIdentity(value: unknown): value is RunnerIdentity {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  // Every field is required. A partial identity would let a Runner connect with
  // an empty credential, which fails later and more confusingly.
  return (
    typeof record["runnerId"] === "string" &&
    record["runnerId"].length > 0 &&
    typeof record["controlUrl"] === "string" &&
    record["controlUrl"].length > 0 &&
    typeof record["credential"] === "string" &&
    record["credential"].length > 0
  );
}
