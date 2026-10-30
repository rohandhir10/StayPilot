import { auth } from '@/auth';
import { redirect } from 'next/navigation';

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?next=%2Fdashboard');

  // The workspace URL deliberately omits ?preview=1, so the client must use
  // an Auth.js-issued API token and never fall back to sample records.
  redirect('/legacy/index.html?workspace=1');
}
