// Runs once when the server starts. Loads the warning model in the background so the first judge
// doesn't wait for it; requests that arrive meanwhile share the same load. With an AI reader key,
// it also reads the judge-mode chats into the cache (PLAN M8), in the background.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NODE_ENV === 'test') return;
  const { warmLocalModel } = await import('./lib/model/local-check');
  void warmLocalModel();
  const [{ warmReaderCache }, { getStore }] = await Promise.all([import('./lib/reader/warm'), import('./lib/settle/runtime')]);
  void Promise.resolve()
    .then(() => warmReaderCache(getStore()))
    .catch(() => undefined);
}
