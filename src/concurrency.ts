/* -------------------------------------------------------------------------
 * A small bounded worker pool.
 *
 * `limit` workers pull items off a shared cursor until it runs out; each
 * item's result lands at its own index in the returned array, regardless of
 * which worker ran it or in what order it finished — callers can zip the
 * result back up against `items` positionally.
 * ---------------------------------------------------------------------- */

export interface MapWithConcurrencyOptions {
  /**
   * Polled before each worker claims its next item. Once it returns `true`,
   * no further items are started — their slot in the result array is left
   * `undefined` — while items already in flight run to completion. Absent,
   * every item runs.
   */
  shouldStop?: () => boolean;
}

/**
 * Runs `worker` over `items` with at most `limit` in flight at once.
 *
 * Without `shouldStop`, every item runs and the result is fully populated —
 * `(R | undefined)[]` still applies, but every slot is in fact an `R`. With
 * `shouldStop`, once it starts returning `true` any item not yet claimed by a
 * worker is never started, and its slot in the returned array stays
 * `undefined` rather than being filled in some other way — callers that pass
 * `shouldStop` must be prepared for holes; callers that don't may rely on a
 * full array.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  options: MapWithConcurrencyOptions = {}
): Promise<(R | undefined)[]> {
  const { shouldStop } = options;
  const results: (R | undefined)[] = [];
  let current = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      if (shouldStop?.()) return;
      const index = current;
      if (index >= items.length) return;
      current += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
