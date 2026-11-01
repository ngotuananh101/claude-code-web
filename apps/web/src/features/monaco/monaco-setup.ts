import * as monaco from "monaco-editor";
// monaco-editor 0.57 maps `"./*": "./esm/vs/*.js"` in its exports map, so the
// `esm/vs/` prefix must be dropped from subpath specifiers — spelling it out
// resolves to `esm/vs/esm/vs/...` and the build fails.
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { defineCcWebThemes } from "./monaco-theme.ts";

let initialized = false;

export function initMonaco(): typeof monaco {
  if (typeof window !== "undefined" && !initialized) {
    self.MonacoEnvironment = {
      getWorker(_: unknown, label: string) {
        if (label === "json") return new jsonWorker();
        if (label === "css" || label === "scss" || label === "less") return new cssWorker();
        if (label === "html" || label === "handlebars" || label === "razor")
          return new htmlWorker();
        if (label === "typescript" || label === "javascript") return new tsWorker();
        return new editorWorker();
      },
    };
    defineCcWebThemes(monaco);
    initialized = true;
  }
  return monaco;
}
