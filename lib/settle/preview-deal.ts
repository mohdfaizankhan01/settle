// Reads a deal for a link preview by ID only: chat apps fetch previews without the link key.

import { getStore } from './runtime';

const DEAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function dealForPreview(id: string) {
  if (!DEAL_ID.test(id)) return undefined;
  try {
    return (await getStore().getDeal(id))?.value;
  } catch {
    // Fail closed: a database error gives the plain Settle Link card, never an error page.
    return undefined;
  }
}
