import { cookies } from 'next/headers';
import { DEMO_COOKIE, demoView } from '@/lib/settle/demo';
import { api, getStore } from '@/lib/settle/runtime';
import { timeline } from '@/lib/settle/timeline';

// The seller timeline for this browser's judge session only.
export async function GET() {
  return api(async () => {
    const session = await demoView(getStore(), (await cookies()).get(DEMO_COOKIE)?.value);
    if (!session) return { timeline: null };
    const stored = await Promise.all(session.deals.map((d) => getStore().getDeal(d.dealId)));
    const deals = session.deals.flatMap((d, i) => (stored[i]?.value.demo ? [{ deal: stored[i]!.value, title: d.title, scenario: d.scenario }] : []));
    return { timeline: timeline(deals, new Date()) };
  });
}
