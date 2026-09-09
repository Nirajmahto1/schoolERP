import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-6">
      <div className="max-w-sm text-center space-y-3">
        <h1 className="text-3xl font-semibold">404</h1>
        <p className="text-slate-400 text-sm">
          No such page — and no such school. Tenant ids and slugs are not
          guessable, so a miss here means the link is wrong.
        </p>
        <Link href="/" className="inline-block rounded-lg bg-sky-600 hover:bg-sky-500 px-4 py-2 text-sm font-medium">
          Back to the console
        </Link>
      </div>
    </main>
  );
}