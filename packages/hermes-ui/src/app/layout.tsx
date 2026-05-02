import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Hermes',
  description: 'Autonomous delivery harness — live dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <header className="border-b border-bg-card">
          <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-3 text-lg font-semibold">
              <span className="text-2xl">🚀</span> Hermes
              <span className="text-xs text-muted font-normal ml-2">autonomous delivery</span>
            </Link>
            <nav className="flex gap-1">
              <NavLink href="/">Overview</NavLink>
              <NavLink href="/engines">Engines</NavLink>
              <NavLink href="/cost">Cost</NavLink>
              <NavLink href="/replay">Replay</NavLink>
            </nav>
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="px-4 py-2 text-sm rounded text-muted hover:bg-bg-hover hover:text-accent transition-colors">
      {children}
    </Link>
  );
}
