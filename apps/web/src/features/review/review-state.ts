const SPLIT_THRESHOLD = 720;

export function defaultDiffMode(containerWidth: number): "unified" | "split" {
  return containerWidth >= SPLIT_THRESHOLD ? "split" : "unified";
}

export type IncomingResolution = "adopt" | "adopt-keep-draft" | "conflict";

export function resolveIncoming(input: {
  currentHash: string;
  incomingHash: string;
  draftDirty: boolean;
}): IncomingResolution {
  const { currentHash, incomingHash, draftDirty } = input;

  if (!draftDirty) {
    return "adopt";
  }

  if (currentHash === incomingHash) {
    return "adopt-keep-draft";
  }

  return "conflict";
}

/**
 * The line separator a CodeMirror document must adopt to round-trip `text`
 * byte for byte. `null` means the default (`\n`). Mixed endings report CRLF so
 * the untouched CRLF lines survive; lone `\n`s stay inside the line content.
 */
export function lineSeparatorFor(text: string): "\r\n" | null {
  return text.includes("\r\n") ? "\r\n" : null;
}

export function reviewKey(path: string, hash: string): string {
  return `${path}\u0000${hash}`;
}

export function isReviewed(reviewed: ReadonlySet<string>, path: string, hash: string): boolean {
  return reviewed.has(reviewKey(path, hash));
}
