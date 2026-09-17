import { AuthProvider } from '@/context/AuthContext';
import { LoadingProvider } from '@/context/LoadingContext';
import { Inter } from 'next/font/google';
import "./globals.css";

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
        <link href="https://fonts.googleapis.com/icon?family=Material+Icons+Outlined" rel="stylesheet" />
        {/* PWA: register the shell service worker (Phase 8.7). Client-only —
            guarded so SSR never touches navigator. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}`,
          }}
        />
      </head>
      <body className={inter.className}>
        <LoadingProvider>
          <AuthProvider>
            {children}
          </AuthProvider>
        </LoadingProvider>
      </body>
    </html>
  );
}
