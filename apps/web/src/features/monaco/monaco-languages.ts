/**
 * Maps file paths to Monaco Editor language identifiers.
 */
export function monacoLanguageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";

  // TypeScript and JavaScript
  if (ext === "ts" || ext === "tsx" || ext === "mts" || ext === "cts") {
    return "typescript";
  }
  if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") {
    return "javascript";
  }

  // Vue (treated as HTML for Monaco)
  if (ext === "vue") {
    return "html";
  }

  // Common web formats
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "css" || ext === "scss" || ext === "sass" || ext === "less") return "css";
  if (ext === "json" || ext === "jsonc") return "json";

  // Markup and config
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "yaml" || ext === "yml") return "yaml";
  if (ext === "xml") return "xml";
  if (ext === "toml") return "ini"; // Monaco doesn't have TOML, INI is close

  // Scripts and shell
  if (ext === "sh" || ext === "bash" || ext === "zsh") return "shell";
  if (ext === "py") return "python";
  if (ext === "rb") return "ruby";
  if (ext === "go") return "go";
  if (ext === "rs") return "rust";
  if (ext === "java") return "java";
  if (ext === "c" || ext === "h") return "c";
  if (ext === "cpp" || ext === "cc" || ext === "cxx" || ext === "hpp") return "cpp";
  if (ext === "cs") return "csharp";
  if (ext === "php") return "php";
  if (ext === "sql") return "sql";

  // Dockerfile
  if (path.toLowerCase().includes("dockerfile")) return "dockerfile";

  // Default to plaintext for unknown or extensionless files
  return "plaintext";
}
