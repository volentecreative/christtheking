/**
 * Run `worker` over `items` with at most `limit` in flight at once.
 *
 * Results come back in INPUT order regardless of completion order, and a
 * worker that throws produces `{ error }` in its slot rather than sinking the
 * whole batch — one bad video shouldn't cost you the other 145.
 *
 * @returns {Promise<Array<{value?: any, error?: Error}>>}
 */
export async function mapWithConcurrency(items, limit, worker) {
  const list = [...items];
  const results = new Array(list.length);
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, list.length));

  let cursor = 0;

  const runner = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= list.length) return;
      try {
        results[index] = { value: await worker(list[index], index) };
      } catch (error) {
        results[index] = { error };
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, runner));
  return results;
}
