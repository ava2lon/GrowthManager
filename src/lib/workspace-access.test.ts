import {describe, expect, it} from "vitest";
import {hasMinimumWorkspaceRole} from "./workspace-access";

describe("workspace role authorization", () => {
  it.each([
    ["OWNER", "OWNER", true],
    ["OWNER", "ADMIN", true],
    ["OWNER", "MEMBER", true],
    ["OWNER", "VIEWER", true],
    ["ADMIN", "OWNER", false],
    ["ADMIN", "ADMIN", true],
    ["ADMIN", "MEMBER", true],
    ["ADMIN", "VIEWER", true],
    ["MEMBER", "OWNER", false],
    ["MEMBER", "ADMIN", false],
    ["MEMBER", "MEMBER", true],
    ["MEMBER", "VIEWER", true],
    ["VIEWER", "OWNER", false],
    ["VIEWER", "ADMIN", false],
    ["VIEWER", "MEMBER", false],
    ["VIEWER", "VIEWER", true],
  ] as const)("role %s meets minimum %s: %s", (actual, minimum, expected) => {
    expect(hasMinimumWorkspaceRole(actual, minimum)).toBe(expected);
  });
});
