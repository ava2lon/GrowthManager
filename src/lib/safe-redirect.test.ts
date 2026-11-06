import {describe, expect, it} from "vitest";
import {getSafeCallbackDestination} from "./safe-redirect";

const origin = "https://growthmanager.vercel.app";

describe("getSafeCallbackDestination", () => {
  it("uses the dashboard when no callback is supplied", () => {
    expect(getSafeCallbackDestination(null, origin)).toBe("/dashboard");
  });

  it("preserves a same-origin invitation callback and its query", () => {
    expect(getSafeCallbackDestination("/invite/abc123?source=email", origin))
      .toBe("/invite/abc123?source=email");
  });

  it("accepts an absolute URL only when it is same-origin", () => {
    expect(getSafeCallbackDestination("https://growthmanager.vercel.app/invite/token", origin))
      .toBe("/invite/token");
  });

  it("rejects protocol-relative external destinations", () => {
    expect(getSafeCallbackDestination("//attacker.example/login", origin)).toBe("/dashboard");
  });

  it("rejects external absolute destinations", () => {
    expect(getSafeCallbackDestination("https://attacker.example/login", origin)).toBe("/dashboard");
  });

  it("rejects malformed destinations", () => {
    expect(getSafeCallbackDestination("http://[invalid", origin)).toBe("/dashboard");
  });

  it("rejects URLs containing credentials even if their textual prefix looks trusted", () => {
    expect(getSafeCallbackDestination("https://growthmanager.vercel.app@attacker.example/path", origin))
      .toBe("/dashboard");
  });
});
