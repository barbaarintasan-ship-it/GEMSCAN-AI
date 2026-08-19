// Release the JS thread between chunks of heavy work.
//
// A long synchronous loop (ranking 37 cells, building a scene from the 20 MB
// pack, requiring the pack files) holds the single JS thread for its whole
// duration, so the native/UI thread cannot paint a frame or deliver a touch
// until it finishes — the app reads as frozen. `await`ing already-resolved
// promises does NOT help: microtasks drain within the same tick. A *macrotask*
// (setTimeout 0) does: it lets the event loop run a native frame before the
// next chunk. This is NOT an added delay — it schedules the continuation for the
// very next macrotask, and it changes nothing about WHAT the loop computes; only
// the thread is yielded between iterations.
//
// Under jest the yield resolves as a MICROTASK (Promise.resolve) instead of a
// macrotask. The distinction it exists for — letting a native frame run — has no
// meaning in a Node test, and a real setTimeout(0) there only leaks timers past
// the assertions ("Cannot log after tests are done"). The wrapped work computes
// the identical result either way — only the moment the thread is handed back
// changes — so a deterministic microtask keeps tests honest while production gets
// the real thread release. The on-device measurement is what proves the latter.
const isJest = typeof process !== "undefined" && !!process.env.JEST_WORKER_ID;

export const yieldToFrame = (): Promise<void> =>
  isJest ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, 0));
