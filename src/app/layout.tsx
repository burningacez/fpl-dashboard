import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/providers';
import { Nav } from '@/components/layout/Nav';
import { SeasonBanner } from '@/components/layout/SeasonBanner';
import { TrafficTracker } from '@/components/layout/TrafficTracker';

// Self-hosted via next/font: no render-blocking Google Fonts request, and the
// font is served from our own origin with the correct cache headers.
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: {
    default: "Barry's FPL Mini League",
    template: "%s · Barry's FPL Mini League",
  },
  description: 'Fantasy Premier League mini-league dashboard',
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/favicon-32.png', sizes: '32x32' },
      { url: '/favicon-192.png', sizes: '192x192' },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: '#111318',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen font-sans">
        <Providers>
          <TrafficTracker />
          <Nav />
          <SeasonBanner />
          {children}
        </Providers>
      </body>
    </html>
  );
}
