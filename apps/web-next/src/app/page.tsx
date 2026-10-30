import { redirect } from 'next/navigation';

export default function HomePage() {
  // The public entry point is a safe, read-only product preview.
  // Authenticated workspace access remains available at /login.
  redirect('/legacy/index.html?preview=1');
}
