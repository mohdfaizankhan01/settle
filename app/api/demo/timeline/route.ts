import { cookies } from 'next/headers';
import { demoView } from '@/lib/settle/demo';
import { api, getStore } from '@/lib/settle/runtime';
import { timeline } from '@/lib/settle/timeline';
import type { Deal } from '@/lib/settle/types';

// The seller timeline for this browser's judge session only.
export async function GET() {
  return api(async () => {
    const session = await demoView(getStore(), (await cookies()).get('settle_judge')?.value);
    if (!session) return { timeline: null };
    const deals: { deal: Deal; title: string; scenario: string }[] = [];
    for (const d of session.deals) {
      const stored = await getStore().getDeal(d.dealId);
      if (stored?.value.demo) deals.push({ deal: stored.value, title: d.title, scenario: d.scenario });
    }
    const t = timeline(deals, new Date());
    return { timeline: { ...t, rows: t.rows.map((r) => ({ ...r, scenario: deals.find((x) => x.deal.id === r.id)!.scenario, title: r.scenario })) } };
  });
}
