/**
 * Buffered File I/O — asynchronous, non-blocking, batch-flush persistence layer
 * Replaces synchronous writeFileSync to eliminate event-loop blocking
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { dirname } from "path";

interface BufferedEntry<T> {
  data: T;
  serializer: (data: T) => string;
  flushTimer?: ReturnType<typeof setTimeout>;
  pending?: Promise<void>;
}

const buffers = new Map<string, BufferedEntry<unknown>>();
const FLUSH_DELAY_MS = 5000;

export async function bufferedWrite<T>(
  filePath: string,
  data: T,
  serializer: (data: T) => string = (d) => JSON.stringify(d, null, 2)
): Promise<void> {
  const entry = buffers.get(filePath) as BufferedEntry<T> | undefined;

  if (entry?.flushTimer) {
    clearTimeout(entry.flushTimer);
  }

  const newEntry: BufferedEntry<T> = {
    data,
    serializer,
    pending: entry?.pending,
  };

  buffers.set(filePath, newEntry as BufferedEntry<unknown>);

  // Schedule flush
  newEntry.flushTimer = setTimeout(() => {
    doFlush(filePath, newEntry);
  }, FLUSH_DELAY_MS);

  // Immediate flush on process exit
  if (!exitHandlerInstalled) {
    installExitHandler();
  }
}

export async function flushAll(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const [path, entry] of buffers.entries()) {
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    promises.push(doFlush(path, entry as BufferedEntry<unknown>));
  }
  await Promise.all(promises);
}

async function doFlush<T>(filePath: string, entry: BufferedEntry<T>): Promise<void> {
  if (entry.pending) {
    await entry.pending;
  }

  const promise = (async () => {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, entry.serializer(entry.data), "utf-8");
    } catch (err) { console.error("[buffered-fs] Error:", err);
      console.error(`[buffered-fs] Flush failed for ${filePath}:`, err);
    } finally {
      buffers.delete(filePath);
    }
  })();

  entry.pending = promise;
  await promise;
}

let exitHandlerInstalled = false;

function installExitHandler() {
  exitHandlerInstalled = true;

  const handler = () => {
    flushAll().then(() => process.exit(0)).catch(() => process.exit(1));
  };

  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  process.on("beforeExit", () => flushAll());
}

/** Direct async read (no buffering for reads) */
export async function asyncRead<T>(
  filePath: string,
  parser: (raw: string) => T = JSON.parse as any,
  fallback: T = null as T
): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return parser(raw);
  } catch (err) { console.error("[buffered-fs] Error:", err);
    return fallback;
  }
}
