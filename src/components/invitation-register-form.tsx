"use client";

import {FormEvent, useState} from "react";
import {signIn} from "next-auth/react";
import {useRouter} from "next/navigation";

export function InvitationRegisterForm({token, email}: {token: string; email: string}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setError("");
    setLoading(true);
    const data = new FormData(event.currentTarget);
    const payload = {
      name: String(data.get("name") ?? ""),
      email,
      password: String(data.get("password") ?? ""),
      token,
    };

    try {
      const response = await fetch("/api/register/invitation", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(result.error || "Unable to create your account.");
        return;
      }

      const login = await signIn("credentials", {
        email,
        password: payload.password,
        redirect: false,
      });
      if (login?.error) {
        setError("Your account was created and the invitation accepted. Sign in to continue.");
        return;
      }
      router.replace("/dashboard");
      router.refresh();
    } catch {
      setError("A network error occurred. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <label className="block text-sm font-medium">Your name
        <input name="name" required minLength={2} maxLength={80} autoComplete="name" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3"/>
      </label>
      <label className="block text-sm font-medium">Create a password (12+ characters)
        <input name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3"/>
      </label>
      {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
      <button disabled={loading} className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">
        {loading ? "Creating account..." : "Create account and join workspace"}
      </button>
    </form>
  );
}
