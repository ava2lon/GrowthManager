import "server-only";
import {lookup} from "node:dns/promises";
import {isIP} from "node:net";

function ipv4ToNumber(address: string): number {
  return address.split(".").reduce((value, part) => (value * 256 + Number(part)) >>> 0, 0);
}

export function isPublicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const value = ipv4ToNumber(address);
  const ranges: Array<[number, number]> = [
    [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
    [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
    [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24],
    [0xe0000000, 4], [0xf0000000, 4],
  ];
  return !ranges.some(([network, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (network & mask);
  });
}

export async function resolveSafeWebhookEndpoint(rawUrl: string): Promise<{url: URL; ipv4: string}> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("WEBHOOK_URL_INVALID"); }
  if (
    url.protocol !== "https:" ||
    url.username || url.password ||
    (url.port && url.port !== "443") ||
    isIP(url.hostname) !== 0 ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname.endsWith(".local") ||
    url.hostname.endsWith(".internal")
  ) throw new Error("WEBHOOK_URL_NOT_ALLOWED");

  let records: Array<{address: string; family: number}>;
  try { records = await lookup(url.hostname, {all: true, family: 4, verbatim: true}); }
  catch { throw new Error("WEBHOOK_DNS_LOOKUP_FAILED"); }
  if (!records.length || records.some((record) => !isPublicIpv4(record.address))) {
    throw new Error("WEBHOOK_DESTINATION_NOT_PUBLIC");
  }
  return {url, ipv4: records[0].address};
}
