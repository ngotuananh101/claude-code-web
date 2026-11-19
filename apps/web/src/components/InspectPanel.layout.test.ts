import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileTemplate, parse } from "vue/compiler-sfc";

const requireWeb = createRequire(new URL("../../package.json", import.meta.url));
const { compile } = requireWeb("tailwindcss") as {
  compile: (css: string) => Promise<{ build: (candidates: string[]) => string }>;
};
const chrome = ["google-chrome", "chromium", "chromium-browser"]
  .map((name) => Bun.which(name))
  .find((path) => path !== null);
const LONG_PATH =
  "apps/desktop/lib/features/downloads/data/datasources/enterprise_download_remote_datasource.dart";
const OLD_PATH = "apps/desktop/lib/features/downloads/data/datasources/old_datasource.dart";

type Measurement = {
  kind: string;
  width: number;
  long: boolean;
  rowWidth: number;
  listWidth: number;
  pathWidth: number;
  pathScrollWidth: number;
  textOverflow: string;
  trailingVisible: boolean;
  title: string;
};

/**
 * Render the actual file-list templates with Vue and the actual Tailwind
 * utilities in Chrome. Happy DOM cannot catch grid intrinsic sizing: removing
 * the zero-minimum track lets a long path expand the row beyond the panel,
 * hiding both its ellipsis and the trailing status/size/revert action.
 * No app server, host port, or browser automation dependency is needed.
 */
describe.skipIf(!chrome)("InspectPanel file-list browser layout", () => {
  let measurements: Measurement[];

  beforeAll(async () => {
    const source = readFileSync(new URL("./InspectPanel.vue", import.meta.url), "utf8");
    const { descriptor } = parse(source);
    const template = descriptor.template!.content;
    const candidates = [...template.matchAll(/class="([^"]*)"/g)].flatMap((match) =>
      match[1]!.split(/\s+/),
    );
    const tailwind = await compile(
      `${readFileSync(requireWeb.resolve("tailwindcss/theme.css"), "utf8")}\n@tailwind utilities;`,
    );
    const css = `${readFileSync(requireWeb.resolve("tailwindcss/preflight.css"), "utf8")}\n${tailwind.build(candidates)}`;
    const vue = readFileSync(new URL(import.meta.resolve("vue/dist/vue.global.prod.js")), "utf8");
    const components = [
      { kind: "files", anchor: 'v-for="entry in entries"' },
      { kind: "git", anchor: 'v-for="entry in changeEntries"' },
      { kind: "snapshot", anchor: 'v-for="entry in snapshotStatus.entries"' },
    ].map(({ kind, anchor }) => {
      const at = template.indexOf(anchor);
      if (at < 0) throw new Error(`Missing ${kind} file list`);
      const list = template.slice(
        template.lastIndexOf("<ul", at),
        template.indexOf("</ul>", at) + 5,
      );
      const compiled = compileTemplate({
        source: list,
        filename: "InspectPanel.vue",
        id: kind,
        compilerOptions: { mode: "function" },
      });
      if (compiled.errors.length) throw new Error(compiled.errors.join("\n"));
      return { kind, render: compiled.code };
    });
    const dir = mkdtempSync(join(tmpdir(), "cc-web-inspect-layout-"));
    try {
      const script = `
        const components = ${JSON.stringify(components)};
        const measurements = [];
        for (const {kind, render} of components) {
          for (const width of [280, 420, 900]) {
            for (const long of [false, true]) {
              const path = long ? ${JSON.stringify(LONG_PATH)} : 'main.ts';
              const origPath = long ? ${JSON.stringify(OLD_PATH)} : undefined;
              const viewport = document.createElement('div');
              viewport.style.cssText = 'width:' + width + 'px;padding:12px;overflow:hidden;font:12px monospace';
              document.body.append(viewport);
              Vue.createApp({
                render: new Function('Vue', render)(Vue),
                setup: () => ({
                  entries: [{name:path,kind:'file',size:12000}],
                  changeEntries: [{path,origPath,status:long?'renamed':'modified'}],
                  snapshotStatus: {entries:[{path,status:'modified',revertable:true}]},
                  STATUS_LABELS: {modified:'M',renamed:'R'},
                  confirmingPath: null,
                  formatSize: () => '12 KB',
                  t: key => key === 'inspect.revert' ? 'revert' : 'modified',
                  openEntry: () => {}, openDiff: () => {},
                }),
              }).mount(viewport);
              const list = viewport.querySelector('ul');
              const row = list.querySelector('li');
              const pathElement = row.querySelector('[title]');
              const trailing = kind === 'snapshot' ? row.lastElementChild : row.querySelector('button').lastElementChild;
              measurements.push({kind,width,long,
                rowWidth:row.getBoundingClientRect().width,
                listWidth:list.getBoundingClientRect().width,
                pathWidth:pathElement.clientWidth,
                pathScrollWidth:pathElement.scrollWidth,
                textOverflow:getComputedStyle(pathElement).textOverflow,
                trailingVisible:trailing.getBoundingClientRect().right <= viewport.getBoundingClientRect().right - 12,
                title:pathElement.title,
              });
            }
          }
        }
        const result = document.createElement('pre');
        result.id = 'measurements'; result.textContent = JSON.stringify(measurements);
        document.body.append(result);
      `;
      writeFileSync(
        join(dir, "fixture.html"),
        `<!doctype html><html><head><style>${css}</style></head><body><script>${vue}</script><script>${script}</script></body></html>`,
      );
      const process = Bun.spawn(
        [
          chrome!,
          "--headless",
          "--disable-gpu",
          "--disable-background-networking",
          "--disable-extensions",
          "--no-first-run",
          "--no-default-browser-check",
          `--user-data-dir=${join(dir, "profile")}`,
          "--dump-dom",
          `file://${join(dir, "fixture.html")}`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [html, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      if (exitCode !== 0) throw new Error(`Chrome exited ${exitCode}: ${stderr}`);
      const result = html.match(/<pre id="measurements">(.*?)<\/pre>/)?.[1];
      if (!result) throw new Error(`Browser fixture did not finish: ${stderr}`);
      measurements = JSON.parse(result) as Measurement[];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  for (const kind of ["files", "git", "snapshot"]) {
    test(`${kind}: long paths ellipsize without hiding the trailing control`, () => {
      const rows = measurements.filter((row) => row.kind === kind && row.long);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.rowWidth).toBeLessThanOrEqual(row.listWidth + 1);
        expect(row.trailingVisible).toBe(true);
        if (row.width <= 420) expect(row.pathScrollWidth).toBeGreaterThan(row.pathWidth);
        expect(row.textOverflow).toBe("ellipsis");
        expect(row.title).toBe(kind === "git" ? `${LONG_PATH} ← ${OLD_PATH}` : LONG_PATH);
      }
    });

    test(`${kind}: short paths remain visible at every panel width`, () => {
      const rows = measurements.filter((row) => row.kind === kind && !row.long);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.trailingVisible).toBe(true);
        expect(row.pathScrollWidth).toBeLessThanOrEqual(row.pathWidth);
        expect(row.title).toBe("main.ts");
      }
    });
  }
});
