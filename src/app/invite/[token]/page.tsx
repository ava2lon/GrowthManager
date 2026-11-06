import Link from "next/link";
import {notFound} from "next/navigation";
import {auth} from "@/auth";
import {db} from "@/lib/db";
import {acceptWorkspaceInvitation} from "@/app/dashboard/team/invitation-actions";
import {InvitationRegisterForm} from "@/components/invitation-register-form";

export default async function InvitationPage({params}: {params: Promise<{token: string}>}) {
  const {token} = await params;
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) notFound();

  const {createHash} = await import("node:crypto");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const invitation = await db.workspaceInvitation.findUnique({
    where: {tokenHash},
    include: {workspace: {select: {name: true}}},
  });
  if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) {
    return <main className="grid min-h-screen place-items-center bg-slate-50 p-6"><div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center"><h1 className="text-xl font-bold text-slate-900">Invitation unavailable</h1><p className="mt-2 text-sm text-slate-500">This invitation may have expired, been revoked, or already been accepted.</p><Link href="/sign-in" className="mt-5 inline-flex rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white">Go to sign in</Link></div></main>;
  }

  const session = await auth();
  const currentEmail = session?.user?.email?.trim().toLowerCase();
  const emailMatches = currentEmail === invitation.email;

  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-bold uppercase tracking-widest text-indigo-600">GrowthManager workspace</p>
        <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">You’re invited</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">Join <strong>{invitation.workspace.name}</strong> as a <strong>{invitation.role.toLowerCase()}</strong>.</p>
        <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">Invitation sent to <strong>{invitation.email}</strong></p>
        {session && !emailMatches ? <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">You are signed in as {session.user?.email}. Sign out and sign in with the invited email address to accept.</div> : session && emailMatches ? (
          <form action={acceptWorkspaceInvitation} className="mt-6"><input type="hidden" name="token" value={token}/><button className="w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-700">Accept invitation</button></form>
        ) : <><p className="mt-5 text-sm text-slate-600">Create an account using this invited email address to join directly. No new workspace will be created.</p><InvitationRegisterForm token={token} email={invitation.email}/><p className="mt-4 text-center text-sm text-slate-500">Already have an account? <Link href={`/sign-in?callbackUrl=${encodeURIComponent(`/invite/${token}`)}`} className="font-semibold text-indigo-600">Sign in to accept</Link></p></>}
        <p className="mt-5 text-center text-xs text-slate-400">This invitation expires {invitation.expiresAt.toLocaleDateString()}.</p>
      </div>
    </main>
  );
}
