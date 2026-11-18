import {describe, expect, it} from "vitest";
import {isPublicIpv4} from "@/lib/webhook-endpoint-security";

describe("webhook destination IPv4 policy", () => {
  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34"])("allows public address %s", (address) => {
    expect(isPublicIpv4(address)).toBe(true);
  });

  it.each([
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1",
    "172.16.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "203.0.113.1",
    "192.88.99.1", "192.31.196.1", "192.175.48.1", "224.0.0.1", "255.255.255.255",
  ])("blocks non-public address %s", (address) => {
    expect(isPublicIpv4(address)).toBe(false);
  });

  it("rejects non-IPv4 inputs", () => {
    expect(isPublicIpv4("::1")).toBe(false);
    expect(isPublicIpv4("not-an-ip")).toBe(false);
  });
});
