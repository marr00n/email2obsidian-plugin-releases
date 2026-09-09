import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../src/concurrency';

/** Resolves after the microtask queue drains `depth` times, without a real timer. */
function tick(depth = 1): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < depth; i++) p = p.then(() => {});
  return p;
}

describe('mapWithConcurrency', () => {
  it('never runs more than `limit` workers at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 8 }, (_, i) => i);

    await mapWithConcurrency(items, 3, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(2);
      inFlight -= 1;
      return item;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('runs every item exactly once across a limited pool', async () => {
    const items = Array.from({ length: 8 }, (_, i) => i);
    const seen: number[] = [];

    await mapWithConcurrency(items, 3, async (item) => {
      seen.push(item);
      await tick(1);
      return item;
    });

    expect(seen.slice().sort((a, b) => a - b)).toEqual(items);
  });

  it('indexes results by input position, not completion order', async () => {
    // Item 0 is the slowest, item 2 the fastest — completion order is 2, 1, 0 —
    // but the returned array must still read [0, 1, 2] positionally.
    const delays = [3, 2, 1];

    const results = await mapWithConcurrency(delays, delays.length, async (delay, index) => {
      await tick(delay);
      return `item-${index}-delay-${delay}`;
    });

    expect(results).toEqual(['item-0-delay-3', 'item-1-delay-2', 'item-2-delay-1']);
  });

  it('limit larger than the item count still runs each item once', async () => {
    const items = ['a', 'b'];
    const results = await mapWithConcurrency(items, 10, async (item) => item.toUpperCase());
    expect(results).toEqual(['A', 'B']);
  });

  it('with shouldStop: finishes in-flight items but starts no new ones', async () => {
    // limit 2 over 5 items: workers pick up items 0 and 1 first. Item 0 flips
    // the stop flag right away but keeps running a while longer; item 1 also
    // keeps running. Neither worker should ever pick up items 2, 3, or 4.
    let stop = false;
    const started: number[] = [];
    const finished: number[] = [];

    const results = await mapWithConcurrency(
      [0, 1, 2, 3, 4],
      2,
      async (item) => {
        started.push(item);
        // Yield once so the sibling worker gets to start before the flag
        // flips — otherwise item 1 would never begin.
        await tick(1);
        if (item === 0) {
          stop = true;
        }
        await tick(2);
        finished.push(item);
        return `done-${item}`;
      },
      { shouldStop: () => stop }
    );

    expect(started.sort()).toEqual([0, 1]);
    expect(finished.sort()).toEqual([0, 1]);
    expect(results[0]).toBe('done-0');
    expect(results[1]).toBe('done-1');
    expect(results[2]).toBeUndefined();
    expect(results[3]).toBeUndefined();
    expect(results[4]).toBeUndefined();
    expect(results).toHaveLength(2);
  });

  it('shouldStop checked before the first item still runs nothing', async () => {
    const worker = async (item: number) => item;
    const results = await mapWithConcurrency([1, 2, 3], 2, worker, {
      shouldStop: () => true,
    });

    expect(results).toEqual([]);
  });

  it('an empty item list resolves to an empty array without calling the worker', async () => {
    let calls = 0;
    const results = await mapWithConcurrency<number, number>([], 3, async (item) => {
      calls += 1;
      return item;
    });

    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });
});
