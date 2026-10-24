/// <reference types="vite/client" />

// Vue SFCs carry no types for tsc; the shim lets every `*.vue` import pass
// typecheck while the real component code is checked by vite's own transform.
declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
