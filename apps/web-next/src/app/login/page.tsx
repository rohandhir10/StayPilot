import { auth, signIn } from '@/auth';
import { redirect } from 'next/navigation';

type Props = { searchParams: Promise<{ next?: string; error?: string }> };
function safeNext(value?: string) { return value && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\\\') ? value : '/'; }

export default async function LoginPage({ searchParams }: Props) {
  const session = await auth();
  const params = await searchParams;
  const next = safeNext(params.next);
  if (session?.user) redirect(next);
  return <main className="auth-shell"><section className="auth-card">
    <div className="brand"><span className="brand-mark">S</span><span><strong>staypilot</strong><small>HOSPITALITY SALES OS</small></span></div>
    <p className="eyebrow">YOUR HOTEL SALES WORKSPACE</p><h1>Welcome back.</h1>
    <p className="intro">Sign in to your team’s shared hotel sales workspace.</p>
    {params.error && <p className="error" role="alert">Sign-in failed. Check your details or contact your workspace administrator.</p>}
    <form action={async () => { 'use server'; await signIn('google', { redirectTo: next }); }}>
      <button className="google-button" type="submit"><span aria-hidden="true">G</span> Continue with Google</button>
    </form>
    {process.env.TEST_LOGIN_ENABLED === 'true' && <div className="test-login">
      <div className="separator"><span>OR USE TEST ACCESS</span></div>
      <form action={async (formData: FormData) => { 'use server'; await signIn('test-credentials', { email: String(formData.get('email') ?? ''), password: String(formData.get('password') ?? ''), redirectTo: next }); }}>
        <label>Email<input name="email" type="email" autoComplete="username" required maxLength={254}/></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required maxLength={256}/></label>
        <button className="test-button" type="submit">Sign in to test workspace</button>
      </form><p className="test-note">Test access is restricted to the configured test account.</p>
    </div>}
    <p className="foot">StayPilot checks workspace membership and role permissions separately after sign-in.</p>
  </section></main>;
}
