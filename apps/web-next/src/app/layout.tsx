import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'StayPilot — Hotel Sales Intelligence', description: 'A shared hotel sales workspace for inquiries, follow-ups and partner relationships.', robots: { index: false, follow: false } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
