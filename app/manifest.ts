import type { MetadataRoute } from 'next';

// Installable web app (PLAN M6, chat-app entry). Once installed on Android, Settle Link appears in
// the share sheet: share the messages where you agreed a deal and the "make a deal link" page opens
// with the chat filled in. The shared text is POSTed, so it never sits in a URL or a server log.
// Chrome on Android hasn't required a service worker to install since version 108.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Settle Link',
    short_name: 'Settle Link',
    description: 'One link to settle a deal made in a DM, paid through PayPal. PayPal sandbox demo.',
    start_url: '/check',
    display: 'standalone',
    background_color: '#f5f7fa',
    theme_color: '#001c64',
    icons: [
      { src: '/icons/192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/512', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
    share_target: {
      action: '/share',
      method: 'POST',
      enctype: 'application/x-www-form-urlencoded',
      params: { title: 'title', text: 'text', url: 'url' },
    },
  };
}
