import { AuthProvider } from '@/context/AuthContext';
import { LoadingProvider } from '@/context/LoadingContext';
import { I18nProvider } from '@/lib/i18n';
import { Inter } from 'next/font/google';
import "./globals.css";
import "./icons.css";

const inter = Inter({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700', '800'],
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <title>School ERP — EduCore</title>
        <meta name="description" content="Comprehensive School ERP System" />
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#2563EB" />
        {/* Icon font is self-hosted (icons.css) — the Google Fonts stylesheet
            was the page's only cross-origin render-blocking request and cost
            ~2.4s of LCP on a cold Lighthouse run. */}
        {/* PWA: register the shell service worker (Phase 8.7). Client-only —
            guarded so SSR never touches navigator. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}`,
          }}
        />
      </head>
      <body className={inter.className}>
        <I18nProvider>
          <LoadingProvider>
            <AuthProvider>
              {children}
            </AuthProvider>
          </LoadingProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
