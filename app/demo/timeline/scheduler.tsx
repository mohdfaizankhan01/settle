'use client';

import '@bryntum/scheduler/fontawesome/css/fontawesome.css';
import '@bryntum/scheduler/fontawesome/css/solid.css';
import '@bryntum/scheduler/scheduler.css';
import '@bryntum/scheduler/stockholm-light.css';
import { BryntumScheduler } from '@bryntum/scheduler-react';
import { useRouter } from 'next/navigation';
import type { TimelineEvent, TimelineRow } from '@/lib/settle/timeline';

export type TimelineData = { start: string; end: string; rows: TimelineRow[]; events: TimelineEvent[] };

export default function Scheduler({ data }: { data: TimelineData }) {
  const router = useRouter();
  const open = (dealId: string) => {
    const row = data.rows.find((r) => r.id === dealId);
    if (row) router.push(`/demo?deal=${encodeURIComponent(row.scenario)}`);
  };
  return (
    <div className="h-[680px] overflow-hidden rounded-md border border-pp-border">
      <BryntumScheduler
        readOnly
        startDate={data.start}
        endDate={data.end}
        viewPreset="dayAndWeek"
        // Fit the whole story in view: the earliest event sits at the left edge.
        tickSize={56}
        visibleDate={{ date: new Date(data.start), block: 'start' }}
        rowHeight={84}
        barMargin={10}
        eventStyle="rounded"
        // Several events can share a day (confirmed, paid, ship-by). Measure the milestone labels so
        // the layout stacks them instead of drawing one label over another.
        milestoneLayoutMode="measure"
        milestoneTextPosition="always-outside"
        resources={data.rows.map((r) => ({ id: r.id, name: r.name, title: r.title, status: r.status, eventColor: r.colour }))}
        events={data.events}
        columns={[
          {
            text: 'Deal',
            field: 'name',
            width: 300,
            htmlEncode: false,
            renderer: ({ record }: { record: { get: (f: string) => string } }) =>
              // One line each, cut with an ellipsis, so three lines always fit the row height.
              `<div style="line-height:1.35;min-width:0;width:100%" title="${escapeHtml(record.get('name'))}: ${escapeHtml(record.get('title'))}">${['<strong>' + escapeHtml(record.get('name')) + '</strong>', '<span style="opacity:.75">' + escapeHtml(record.get('title')) + '</span>', escapeHtml(record.get('status'))].map((l) => `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${l}</div>`).join('')}</div>`,
          },
        ]}
        eventTooltipFeature={{ template: ({ eventRecord }: { eventRecord: { get: (f: string) => string; name: string } }) => `<b>${escapeHtml(eventRecord.name)}</b><br>${escapeHtml(eventRecord.get('detail'))}` }}
        onEventClick={({ resourceRecord }) => open(String(resourceRecord.id))}
        onCellClick={({ record }) => open(String(record.id))}
      />
    </div>
  );
}

function escapeHtml(s: string | undefined) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
