// Runs once when the server starts. Loads the warning model in the background so the first judge
// doesn't wait for it; requests that arrive meanwhile share the same load.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NODE_ENV === 'test') return;
  const { warmLocalModel } = await import('./lib/model/local-check');
  void warmLocalModel();
}
