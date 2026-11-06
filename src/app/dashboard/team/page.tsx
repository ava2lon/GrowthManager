import {requireWorkspaceContext} from "@/lib/workspace";
import {db} from "@/lib/db";
import {updateMemberRole, removeWorkspaceMember} from "./actions";
import {createWorkspaceInvitation, revokeWorkspaceInvitation} from "./invitation-actions";

const roleOptions = ["ADMIN", "MEMBER", "VIEWER"] as const;

export default async function TeamPage() {
  const {workspace, membership} = await requireWorkspaceContext();
  const members = await db.workspaceMembership.findMany({
    where: {workspaceId: workspace.id},
    include: {user: {select: {id: true, name: true, email: true}}},
    orderBy: [{role: "asc"}, {createdAt: "asc"}],
  });
  const canManage = membership.role === "OWNER" || membership.role === "ADMIN";
  const invitations = await db.workspaceInvitation.findMany({
    where: {workspaceId: workspace.id, acceptedAt: null, revokedAt: null, expiresAt: {gt: new Date()}},
    orderBy: {createdAt: "desc"},
    select: {id: true, email: true, role: true, expiresAt: true},
  });


  return (
    <div className="space-y-7">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-indigo-600">Workspace settings</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">Team members</h1>
          <p className="mt-2 text-sm text-slate-500">Manage access to {workspace.name}.</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          <span className="font-semibold text-slate-900">{members.length}</span> {members.length === 1 ? "member" : "members"}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="hidden grid-cols-[minmax(0,1fr)_140px_260px] gap-4 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 sm:grid">
          <span>Member</span><span>Role</span><span>Access management</span>
        </div>
        <div className="divide-y divide-slate-100">
          {members.map((member) => {
            const isSelf = member.userId === membership.userId;
            const protectedMember = member.role === "OWNER";
            const canManageTarget = canManage && !isSelf && !protectedMember &&
              (membership.role === "OWNER" || member.role !== "ADMIN");

            return (
              <div key={member.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_140px_260px] sm:items-center sm:gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid size-10 shrink-0 place-items-center rounded-full bg-indigo-50 text-sm font-bold text-indigo-700">
                    {(member.user.name || member.user.email).slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900">{member.user.name || "Unnamed user"} {isSelf && <span className="font-normal text-slate-400">(you)</span>}</p>
                    <p className="truncate text-xs text-slate-500">{member.user.email}</p>
                  </div>
                </div>
                <div><span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">{member.role.toLowerCase()}</span></div>
                <div>
                  {canManageTarget ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <form action={updateMemberRole} className="flex items-center gap-2">
                        <input type="hidden" name="userId" value={member.userId}/>
                        <label htmlFor={`role-${member.id}`} className="sr-only">Role for {member.user.email}</label>
                        <select id={`role-${member.id}`} name="role" defaultValue={member.role} className="min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-700">
                          {roleOptions.filter((role) => membership.role === "OWNER" || role !== "ADMIN").map((role) => <option key={role} value={role}>{role.toLowerCase()}</option>)}
                        </select>
                        <button className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-700">Save</button>
                      </form>
                      <form action={removeWorkspaceMember}>
                        <input type="hidden" name="userId" value={member.userId}/>
                        <button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:border-red-200 hover:text-red-600">Remove</button>
                      </form>
                    </div>
                  ) : <p className="text-xs text-slate-400">{protectedMember ? "Owner access is protected" : isSelf ? "Your membership" : "Managed by workspace owner"}</p>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {canManage && <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-slate-900">Invite a teammate</h2>
        <p className="mt-1 text-sm text-slate-500">Invitations expire after seven days and can only be accepted by the invited email address.</p>
        <form action={createWorkspaceInvitation} className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px_auto]">
          <label className="grid gap-1.5 text-xs font-medium text-slate-600">Email address<input required type="email" name="email" maxLength={254} placeholder="teammate@company.com" className="rounded-lg border border-slate-200 px-3 py-2.5 text-sm font-normal outline-none focus:border-indigo-400"/></label>
          <label className="grid gap-1.5 text-xs font-medium text-slate-600">Initial role<select name="role" defaultValue="MEMBER" className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal">{(membership.role === "OWNER" ? ["ADMIN","MEMBER","VIEWER"] : ["MEMBER","VIEWER"]).map(role=><option key={role} value={role}>{role.toLowerCase()}</option>)}</select></label>
          <button className="self-end rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700">Send invitation</button>
        </form>
        <div className="mt-6 border-t border-slate-100 pt-5">
          <h3 className="text-sm font-semibold text-slate-800">Pending invitations ({invitations.length})</h3>
          {invitations.length === 0 ? <p className="mt-2 text-sm text-slate-400">No pending invitations.</p> : <div className="mt-3 divide-y divide-slate-100">{invitations.map(invite=><div key={invite.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="text-sm font-medium text-slate-800">{invite.email}</p><p className="mt-0.5 text-xs text-slate-500">{invite.role.toLowerCase()} · Expires {invite.expiresAt.toLocaleDateString()}</p></div><form action={revokeWorkspaceInvitation}><input type="hidden" name="invitationId" value={invite.id}/><button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:border-red-200 hover:text-red-600">Revoke</button></form></div>)}</div>}
        </div>
      </section>}
    </div>
  );
}
