import "@testing-library/jest-dom";
import { vi } from "vitest";

if (typeof window !== "undefined") {
  (window as any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
}

// Polyfill scrollTo for jsdom
if (typeof Element !== "undefined" && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = vi.fn() as any;
}

// ---------------------------------------------------------------------------
// Framer Motion mock — prevents motion-specific props (whileHover, animate …)
// from being forwarded to real DOM elements in jsdom, which causes React
// "does not recognize prop on DOM element" warnings.
// ---------------------------------------------------------------------------

/** Props that Framer Motion consumes but must never reach a DOM element. */
const MOTION_PROPS = new Set([
  "whileHover",
  "whileTap",
  "whileFocus",
  "whileDrag",
  "whileInView",
  "animate",
  "initial",
  "exit",
  "variants",
  "transition",
  "layoutId",
  "layout",
  "drag",
  "dragConstraints",
  "dragElastic",
  "dragMomentum",
  "dragPropagation",
  "dragDirectionLock",
  "onDragStart",
  "onDrag",
  "onDragEnd",
  "onDragTransitionEnd",
  "onAnimationStart",
  "onAnimationComplete",
  "onAnimationIteration",
  "onHoverStart",
  "onHoverEnd",
  "onTapStart",
  "onTap",
  "onTapCancel",
  "onPanStart",
  "onPan",
  "onPanEnd",
  "custom",
  "inherit",
  "onViewportEnter",
  "onViewportLeave",
  "viewport",
  "positionTransition",
  "layoutTransition",
  "transformTemplate",
]);

vi.mock("framer-motion", async () => {
  const { createElement } = await import("react");

  function createMotionComponent(tag: string) {
    return function MotionEl({ children, ...rawProps }: Record<string, unknown> & { children?: unknown }) {
      const domProps: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(rawProps)) {
        if (!MOTION_PROPS.has(key)) domProps[key] = val;
      }
      return createElement(tag as any, domProps, children as any);
    };
  }

  const motion = new Proxy({} as Record<string, unknown>, {
    get: (_, tag: string) => createMotionComponent(tag),
  });

  const passThrough = ({ children }: { children?: unknown }) => children ?? null;

  return {
    motion,
    AnimatePresence: passThrough,
    LayoutGroup: passThrough,
    MotionConfig: passThrough,
    LazyMotion: passThrough,
    domAnimation: {},
    domMax: {},
    useAnimation: () => ({ start: vi.fn(), stop: vi.fn(), set: vi.fn() }),
    useMotionValue: (initial?: unknown) => ({ get: () => initial, set: vi.fn(), onChange: vi.fn() }),
    useSpring: (initial?: unknown) => ({ get: () => initial, set: vi.fn(), onChange: vi.fn() }),
    useTransform: () => ({ get: vi.fn(), set: vi.fn(), onChange: vi.fn() }),
    useScroll: () => ({
      scrollY: { get: vi.fn(), set: vi.fn(), onChange: vi.fn() },
      scrollX: { get: vi.fn(), set: vi.fn(), onChange: vi.fn() },
      scrollYProgress: { get: vi.fn(), set: vi.fn(), onChange: vi.fn() },
      scrollXProgress: { get: vi.fn(), set: vi.fn(), onChange: vi.fn() },
    }),
    useDragControls: () => ({ start: vi.fn() }),
    useInView: () => false,
    useReducedMotion: () => false,
  };
});

// ---------------------------------------------------------------------------
// Suppress known jsdom/library-internal prop warnings that cannot be fixed
// in our own code.
// ---------------------------------------------------------------------------

// console.error filter
// • AntD Card forwards `hoverable` boolean to the underlying DOM element.
//   React issues this as: console.error("… non-boolean attribute `%s` …", "hoverable")
//   so "hoverable" appears in args[1], not args[0].
const _origError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  // Join all args so we catch attribute names regardless of which slot they're in
  const joined = args.map((a) => String(a ?? "")).join(" ");
  // AntD Card forwards `hoverable` boolean to DOM
  if (joined.includes("non-boolean attribute") && joined.includes("hoverable")) return;
  // AntD TextArea autoSize uses scrollHeight (always 0 in jsdom) → NaN height
  if (joined.includes("NaN") && joined.includes("height") && joined.includes("css style")) return;
  // AntD timer-based state updates (CSSMotion, Notifications, message API) fire
  // after test assertions complete, causing act() warnings. These are library-
  // internal and do not indicate bugs in our async handling.
  if (joined.includes("was not wrapped in act")) return;
  _origError(...args);
};

// console.warn filter
// • React Router v6 prints future-flag migration notices on every render —
//   these are informational only and not relevant to test assertions.
const _origWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  const msg = String(args[0] ?? "");
  if (msg.includes("React Router Future Flag Warning")) return;
  _origWarn(...args);
};

// ---------------------------------------------------------------------------
// Cytoscape mock — cytoscape requires a real HTML canvas which is unavailable
// in jsdom. We provide a minimal stub so the component renders without crash.
// ---------------------------------------------------------------------------
vi.mock("cytoscape", () => {
  return {
    default: function cytoscapeStub(this: any, opts: any) {
      const nodesMap = new Map<string, any>();
      const edgesMap = new Map<string, any>();
      if (opts.elements) {
        for (const el of opts.elements) {
          if (el.data.source && el.data.target) {
            edgesMap.set(el.data.id, el);
          } else {
            nodesMap.set(el.data.id, el);
          }
        }
      }
      const cy = {
        nodes: () => ({
          unselect: vi.fn(),
          select: vi.fn(),
        }),
        getElementById: (id: string) => ({
          length: nodesMap.has(id) ? 1 : 0,
          select: vi.fn(),
        }),
        animate: vi.fn(),
        on: vi.fn(),
        destroy: vi.fn(),
        _nodes: nodesMap,
        _edges: edgesMap,
      };
      // schedule layout callback if present
      if (opts.layout?.fit && typeof opts.layout.animate === "boolean") {
        // no-op: layout runs synchronously in real cytoscape
      }
      return cy;
    },
  };
});
