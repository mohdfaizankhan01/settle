import { Shell } from '@/app/components/shell';

export const metadata = { title: 'PayPal connection' };

const TEXT: Record<string, { title: string; body: string }> = {
  connected: { title: 'Your PayPal account is connected', body: 'Close this tab and go back to your deal page. The buyer will pay your PayPal account directly.' },
  pending: {
    title: 'PayPal has not finished connecting your account',
    body: 'Go back to your deal page and press “I’ve finished connecting” in a minute. If it still doesn’t connect, start again from the deal page.',
  },
  unknown: { title: 'This connection link is out of date', body: 'Go back to your deal page and connect PayPal again from there.' },
  error: { title: 'Settle could not check your PayPal connection', body: 'Go back to your deal page and press “I’ve finished connecting” to try again.' },
};

export default async function Connected({ searchParams }: PageProps<'/connected'>) {
  const { status } = await searchParams;
  const t = TEXT[typeof status === 'string' && Object.hasOwn(TEXT, status) ? status : 'error'];
  return (
    <Shell>
      <h1 className="text-[28px] font-semibold text-pp-navy">{t.title}</h1>
      <p className="mt-2 max-w-prose text-pp-muted">{t.body}</p>
    </Shell>
  );
}
