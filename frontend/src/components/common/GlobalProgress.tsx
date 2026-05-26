import { useEffect, useState } from "react";

let globalLoadingCount = 0;
const listeners = new Set<(count: number) => void>();

export function setGlobalLoading(delta: number) {
  globalLoadingCount = Math.max(0, globalLoadingCount + delta);
  listeners.forEach((fn) => fn(globalLoadingCount));
}

/** Reset internal state — intended for tests only */
export function _resetGlobalLoading() {
  globalLoadingCount = 0;
  listeners.clear();
}

export function GlobalProgressBar() {
  const [visible, setVisible] = useState(globalLoadingCount > 0);

  useEffect(() => {
    const handler = (count: number) => setVisible(count > 0);
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        zIndex: 9999,
        background: "linear-gradient(90deg, #1677ff, #69b1ff)",
        animation: "global-progress 1s ease-in-out infinite",
      }}
    >
      <style>{`
        @keyframes global-progress {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </div>
  );
}
