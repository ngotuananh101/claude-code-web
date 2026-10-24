# Native shadcn-vue theme — remove all custom theme CSS (2026-10-24)

Request: "Loại bỏ hết theme css custom, tôi muốn lấy nguyên xi từ shadcn-vue."
This reverses the Task-3 palette-continuity ruling of 2026-10-24-shadcn-ui.md:
the generated `index.css` theme (vega preset — red primary, neutral grays,
radius 0.625rem) governs everything; no custom palette layer exists anymore.

## Rulings

| # | Question | Verdict |
|---|----------|---------|
| 1 | Does "hết theme custom" include app.css and scoped styles? | Palette/typography rules in scoped styles are theme — they must reference shadcn semantic vars (`--primary`, `--muted-foreground`, `--border`, `--destructive`, `--accent`, `--muted`, `--foreground`, `--background`, `--sidebar`) or Tailwind utilities. Scoped *layout* rules (flex/padding/height) stay. `tokens.css` is deleted outright. |
| 2 | Machine voice (`.mono` / IBM Plex Mono)? | Removed. `font-mono` (Tailwind default mono stack) replaces `.mono` everywhere. One voice now: `--font-sans`. |
| 3 | Fonts? | Remove `@fontsource/instrument-sans` + `@fontsource/ibm-plex-mono`; add `@fontsource-variable/inter` (family name "Inter Variable" = exactly what the generated `--font-sans` declares; self-hosted). Keep `components.json` without a `font` key so the CLI never re-injects the Google-Fonts network import (self-hosted control plane, §19.4 spirit). |
| 4 | Generated index.css header comment (ours, mentions tokens.css)? | Deleted — restores the file to CLI-native shape. Verified byte-stable afterwards by rerunning `shadcn-vue add badge` (0 diff). |
| 5 | Connected-vs-repairing chip colors under the red theme? | connected → `--primary` (red), repairing/attention → `--destructive` (red), offline → `--muted-foreground`. Tone class *names* stay (`pine`/`amber`/`mute`) to avoid touching component logic; only their color values change. |
| 6 | Session rail background? | `var(--sidebar)` — the generated sidebar token, the shadcn-native surface for a nav rail. |

## Tasks

1. **Strip the custom theme layer** — delete `apps/web/src/styles/tokens.css`;
   shrink `app.css` to the layout-only height chain (`html, body, #app { height: 100% }`);
   main.ts drops tokens.css + both custom fontsource imports, adds
   `@fontsource-variable/inter`; index.css loses our header comment (back to
   CLI-native).
2. **Convert every palette reference in scoped styles to shadcn vars** —
   LoginView, SessionRail, ConnectionChip, EventJournal, SessionView,
   Composer. Mapping: pine→primary, pine-wash→accent, amber→destructive
   (amber-wash→ destructive at 10% via color-mix), mute→muted-foreground,
   line→border, ink→foreground, paper→background, #f4f5f1→muted (rail uses
   sidebar), #fff→background (composer drops its own bg). `.mono` →
   `font-mono`; scoped `font-family: var(--machine|--voice)` declarations go.
3. **Swap font packages** — `bun remove @fontsource/instrument-sans
   @fontsource/ibm-plex-mono && bun add @fontsource-variable/inter`.
4. **Docs** — CLAUDE.md: replace the tokens.css/palette sentences with "the
   theme is the generated index.css; do not add a custom theme layer (owner
   decision 2026-10-24)"; keep the Google-Fonts checklist (still enforced).
   Update memory handoff.

## Verification

- grep: zero references to `--pine|--paper|--ink|--line|--mute\b|--amber|--voice|--machine` and zero `.mono` in our sources.
- `bun run lint` (0 errors), `bun run typecheck`, `bun test` (399/399),
  real build `cd apps/web && bun run build`.
- `bunx shadcn-vue add badge` rerun → git diff on generated paths is empty.
- Browser pass on the running dev servers: login + session views render the
  generated theme (red primary button, neutral grays, system-Inter body).
- Commit + push to main (standing authorization); report in Vietnamese.
