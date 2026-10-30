import { auth } from '@/auth';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect('/login?next=%2Fdashboard');
  return <main style={{ height: '100dvh', width: '100%', overflow: 'hidden' }}>
    <iframe title="StayPilot hotel sales workspace" src="/legacy/index.html" style={{ display: 'block', width: '100%', height: '100%', border: 0 }} />
  </main>;
}
