import {describe, expect, it} from "vitest";
import type {WorkspaceRole} from "@prisma/client";
import {
  canChangeWorkspaceMemberRole,
  canRemoveWorkspaceMember,
} from "./workspace-member-policy";

const roles: WorkspaceRole[] = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];

describe("workspace member role changes", () => {
  it.each(roles.flatMap((actor) =>
    roles.flatMap((target) =>
      roles.map((next) => ({
        actor,
        target,
        next,
        expected:
          (actor === "OWNER" || actor === "ADMIN") &&
          target !== "OWNER" &&
          next !== "OWNER" &&
          !(actor === "ADMIN" && (target === "ADMIN" || next === "ADMIN")),
      })),
    ),
  ))("$actor changing $target to $next => $expected", ({actor, target, next, expected}) => {
    expect(canChangeWorkspaceMemberRole(actor, target, next)).toBe(expected);
  });
});

describe("workspace member removal", () => {
  it.each(
    roles.flatMap((actor) =>
      roles.flatMap((target) =>
        [false, true].map((isSelf) => ({
          actor,
          target,
          isSelf,
          expected:
            (actor === "OWNER" || actor === "ADMIN") &&
            !isSelf &&
            target !== "OWNER" &&
            !(actor === "ADMIN" && target === "ADMIN"),
        })),
      ),
    ),
  )("$actor removing $target (self=$isSelf) => $expected", ({actor, target, isSelf, expected}) => {
    expect(canRemoveWorkspaceMember(actor, target, isSelf)).toBe(expected);
  });
});
