import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'ZarghamFlow',
  description: 'Multi-user planner and admin dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
