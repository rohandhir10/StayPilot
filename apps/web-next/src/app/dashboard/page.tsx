import { auth } from '@/auth';
import { redirect } from 'next/navigation';

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?next=%2Fdashboard');
  redirect('/legacy/index.html?workspace=1');
}
