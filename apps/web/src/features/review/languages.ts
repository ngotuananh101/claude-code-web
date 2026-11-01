import type { Extension } from "@codemirror/state";

export type LanguageId = "javascript" | "json" | "markdown" | "python" | "html" | "css";

const EXTENSION_MAP: Record<string, LanguageId> = {
  ts: "javascript",
  tsx: "javascript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  mts: "javascript",
  cts: "javascript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  pyi: "python",
  html: "html",
  htm: "html",
  css: "css",
};

export function languageForPath(path: string): LanguageId | null {
  const lowerPath = path.toLowerCase();
  const lastDot = lowerPath.lastIndexOf(".");
  if (lastDot === -1) {
    return null;
  }
  const ext = lowerPath.slice(lastDot + 1);

  // Handle .d.ts specially: it's a two-part extension
  if (lowerPath.endsWith(".d.ts")) {
    return "javascript";
  }

  return EXTENSION_MAP[ext] ?? null;
}

const loaders: Record<LanguageId, () => Promise<Extension>> = {
  javascript: async () => (await import("@codemirror/lang-javascript")).javascript(),
  json: async () => (await import("@codemirror/lang-json")).json(),
  markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
  python: async () => (await import("@codemirror/lang-python")).python(),
  html: async () => (await import("@codemirror/lang-html")).html(),
  css: async () => (await import("@codemirror/lang-css")).css(),
};

/**
 * One promise per language id, shared by every editor that asks for it.
 * A rejected load is evicted instead of cached: a transient chunk failure must
 * be retried on the next request, not disable highlighting until reload.
 */
export function createLanguageLoader(
  loaderMap: Record<LanguageId, () => Promise<Extension>>,
): (id: LanguageId) => Promise<Extension> {
  const cache = new Map<LanguageId, Promise<Extension>>();
  return (id) => {
    const cached = cache.get(id);
    if (cached) {
      return cached;
    }
    const promise = loaderMap[id]().catch((error: unknown) => {
      cache.delete(id);
      throw error;
    });
    cache.set(id, promise);
    return promise;
  };
}

export const loadLanguage = createLanguageLoader(loaders);
