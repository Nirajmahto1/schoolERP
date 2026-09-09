import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth";
import ProvisionForm from "./provision-form";

export const dynamic = "force-dynamic";

export default async function ProvisionPage() {
  const admin = await currentAdmin();
  if (!admin) redirect("/login");

  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Provision a school</h1>
        <p className="text-sm text-slate-400 mt-1">
          Creates the database, applies the schema, seeds India defaults (class
          ladder, fee structures, first admin), indexes the login directory, and
          flips the tenant to TRIAL. Fully rolled back on any failure.
        </p>
      </header>
      <ProvisionForm />
    </main>
  );
}
