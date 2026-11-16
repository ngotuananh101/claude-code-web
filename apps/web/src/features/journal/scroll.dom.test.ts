import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRenderer, defineComponent, h } from "vue";
import { capturePrependAnchor } from "./scroll.ts";
import { usePrependAnchor } from "./use-prepend-anchor.ts";

/** Narrow owner harness: real Vue unmount hooks, without compiling/stubbing SFCs. */
function mountOwner(window: Window) {
  const document = window.document as unknown as Document;
  let capture: typeof capturePrependAnchor = capturePrependAnchor;
  const renderer = createRenderer<Node, HTMLElement>({
    patchProp(element, key, _previous, next) {
      if (next === null) element.removeAttribute(key);
      else element.setAttribute(key, String(next));
    },
    insert: (child, parent, anchor) => parent.insertBefore(child, anchor ?? null),
    remove: (child) => child.parentNode?.removeChild(child),
    createElement: (tag) => document.createElement(tag),
    createText: (text) => document.createTextNode(text),
    createComment: (text) => document.createComment(text),
    setText(node, text) {
      node.nodeValue = text;
    },
    setElementText(element, text) {
      element.textContent = text;
    },
    parentNode: (node) => node.parentElement,
    nextSibling: (node) => node.nextSibling,
  });
  const app = renderer.createApp(
    defineComponent({
      setup() {
        capture = usePrependAnchor();
        return () => h("span");
      },
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  app.mount(container);
  return { capture, app };
}

/**
 * Real DOM/style/query/lifecycle coverage, not a browser layout test. Happy DOM
 * has no layout engine: only geometry is controlled; the production helper
 * receives actual elements and a static querySelectorAll NodeList.
 */
function fixture() {
  const window = new Window();
  const document = window.document as unknown as Document;
  const root = document.createElement("div");
  root.innerHTML = `
    <div data-slot="scroll-area-viewport">
      <div data-content>
        <article data-turn-key="hidden"></article>
        <article data-turn-key="visible"></article>
        <article data-turn-key="tail"></article>
      </div>
    </div>`;
  document.body.append(root);
  const viewport = root.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
  const content = viewport.querySelector<HTMLElement>("[data-content]")!;
  const visible = content.querySelector<HTMLElement>('[data-turn-key="visible"]')!;
  const geometry = { prepend: 0, tail: 0 };
  viewport.scrollTop = 200;
  Object.defineProperties(viewport, {
    scrollHeight: { get: () => 1000 + geometry.prepend + geometry.tail },
    clientHeight: { get: () => 400 },
  });
  viewport.getBoundingClientRect = () => new window.DOMRect(0, 0, 600, 400);
  for (const [key, top, height] of [
    ["hidden", -100, 100],
    ["visible", 100, 300],
    ["tail", 700, 200],
  ] as const) {
    const element = content.querySelector<HTMLElement>(`[data-turn-key="${key}"]`)!;
    element.getBoundingClientRect = () =>
      new window.DOMRect(0, top + geometry.prepend - viewport.scrollTop, 600, height);
  }
  return { window, root, viewport, content, visible, geometry };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("prepend anchor DOM contract", () => {
  test("keeps the visible turn at the reader's new position while an older page and live tail arrive", async () => {
    const { window, viewport, content, visible, geometry } = fixture();
    try {
      viewport.style.setProperty("overflow-anchor", "auto");
      const anchor = capturePrependAnchor(
        viewport,
        content.querySelectorAll<HTMLElement>("[data-turn-key]"),
      );
      const request = deferred();
      const load = (async () => {
        try {
          await request.promise;
          anchor.restore();
        } finally {
          anchor.release();
        }
      })();
      expect(viewport.style.getPropertyValue("overflow-anchor")).toBe("none");
      viewport.scrollTop += 50;
      expect(visible.getBoundingClientRect().top).toBe(-150);
      geometry.prepend = 300;
      geometry.tail = 700;
      // A static NodeList must still anchor an existing turn after DOM prepend.
      content.prepend(content.ownerDocument.createElement("article"));
      request.resolve();
      await load;
      expect(viewport.scrollTop).toBe(550);
      expect(visible.getBoundingClientRect().top).toBe(-150);
      expect(viewport.style.getPropertyValue("overflow-anchor")).toBe("auto");
    } finally {
      await window.happyDOM.close();
    }
  });

  test.each([
    ["", "", ""],
    ["auto", "", "overflow-anchor: auto;"],
    ["auto", "important", "overflow-anchor: auto !important;"],
  ])(
    "restores the original inline declaration %j with priority %j",
    async (value, priority, css) => {
      const { window, viewport, content } = fixture();
      try {
        if (value !== "") viewport.style.setProperty("overflow-anchor", value, priority);
        const anchor = capturePrependAnchor(
          viewport,
          content.querySelectorAll<HTMLElement>("[data-turn-key]"),
        );
        expect(viewport.style.getPropertyValue("overflow-anchor")).toBe("none");
        anchor.restore();
        expect(viewport.style.cssText).toBe(css);
        expect(viewport.style.getPropertyPriority("overflow-anchor")).toBe(priority);
      } finally {
        await window.happyDOM.close();
      }
    },
  );

  test("releases native anchoring when an asynchronous history request rejects", async () => {
    const { window, viewport, content, geometry } = fixture();
    try {
      viewport.style.setProperty("overflow-anchor", "auto");
      const anchor = capturePrependAnchor(
        viewport,
        content.querySelectorAll<HTMLElement>("[data-turn-key]"),
      );
      const request = deferred();
      const load = (async () => {
        try {
          await request.promise;
          anchor.restore();
        } finally {
          anchor.release();
        }
      })();
      viewport.scrollTop += 50;
      geometry.tail = 700;
      request.reject(new Error("history unavailable"));
      await expect(load).rejects.toThrow("history unavailable");
      expect(viewport.scrollTop).toBe(250);
      expect(viewport.style.getPropertyValue("overflow-anchor")).toBe("auto");
    } finally {
      await window.happyDOM.close();
    }
  });

  test("releases a detached route's anchor without scrolling its old viewport", async () => {
    const { window, root, viewport, content, visible, geometry } = fixture();
    try {
      viewport.style.setProperty("overflow-anchor", "auto");
      const owner = mountOwner(window);
      const anchor = owner.capture(
        viewport,
        content.querySelectorAll<HTMLElement>("[data-turn-key]"),
      );
      const request = deferred();
      const load = (async () => {
        try {
          await request.promise;
          // A cancelled request can still settle after its route detached.
          anchor.restore();
        } finally {
          anchor.release();
        }
      })();
      viewport.scrollTop += 50;
      owner.app.unmount();
      root.remove();
      expect(visible.isConnected).toBe(false);
      expect(viewport.style.getPropertyValue("overflow-anchor")).toBe("auto");
      geometry.prepend = 300;
      geometry.tail = 700;
      request.resolve();
      await load;
      expect(viewport.scrollTop).toBe(250);
      expect(viewport.style.getPropertyValue("overflow-anchor")).toBe("auto");
    } finally {
      await window.happyDOM.close();
    }
  });
});
