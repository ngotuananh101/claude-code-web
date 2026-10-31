const SPLIT_THRESHOLD = 720;

export function defaultDiffMode(containerWidth: number): "unified" | "split" {
  return containerWidth >= SPLIT_THRESHOLD ? "split" : "unified";
}

export function resolveIncoming(input: {
  currentHash: string;
  incomingHash: string;
  draftDirty: boolean;
}): "adopt" | "conflict" {
  const { currentHash, incomingHash, draftDirty } = input;

  if (!draftDirty) {
    return "adopt";
  }

  if (currentHash === incomingHash) {
    return "adopt";
  }

  return "conflict";
}

export function reviewKey(path: string, hash: string): string {
  return `${path}\u0000${hash}`;
}

export function isReviewed(reviewed: ReadonlySet<string>, path: string, hash: string): boolean {
  return reviewed.has(reviewKey(path, hash));
}
