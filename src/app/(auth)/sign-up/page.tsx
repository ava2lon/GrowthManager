"use client";

import Link from "next/link";
import {FormEvent, useState} from "react";
import {useRouter} from "next/navigation";
import {BrandMark} from "@/components/brand-mark";

const fields = [
  {name:"name",label:"Your name",type:"text",placeholder:"Alex Morgan"},
  {name:"email",label:"Work email",type:"email",placeholder:"alex@company.com"},
  {name:"workspaceName",label:"Workspace name",type:"text",placeholder:"Acme Growth Team"},
  {name:"password",label:"Password (12+ characters)",type:"password",placeholder:"Choose a strong password"},
];

export default function SignUpPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setError("");
    setLoading(true);

    try {
      const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
      const response = await fetch("/api/register", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(result.error || "Unable to create account.");
        return;
      }

      const auth = await import("next-auth/react");
      const login = await auth.signIn("credentials", {
        email: payload.email,
        password: payload.password,
        redirect: false,
      });

      if (login?.error) {
        router.push("/sign-in");
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("A network error occurred. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6 py-12">
      <div className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <BrandMark/>
        <h1 className="mt-10 text-3xl font-bold">Create your workspace</h1>
        <p className="mt-2 text-sm text-slate-500">Create your account and workspace in one step.</p>
        <form onSubmit={submit} className="mt-8 space-y-4">
          {fields.map((field) => (
            <label key={field.name} className="block text-sm font-medium">
              {field.label}
              <input
                name={field.name}
                required
                type={field.type}
                minLength={field.name === "password" ? 12 : 2}
                maxLength={field.name === "password" ? 128 : 80}
                autoComplete={field.name === "password" ? "new-password" : field.name === "email" ? "email" : "name"}
                className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3"
                placeholder={field.placeholder}
              />
            </label>
          ))}
          {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
          <button disabled={loading} className="w-full rounded-xl bg-indigo-600 px-4 py-3.5 text-sm font-semibold text-white disabled:opacity-60">
            {loading ? "Creating workspace..." : "Create workspace"}
          </button>
        </form>
        <p className="mt-7 text-center text-sm text-slate-500">
          Already registered? <Link href="/sign-in" className="font-semibold text-indigo-600">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
