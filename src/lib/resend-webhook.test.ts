import {createHmac} from "node:crypto";
import {describe, expect, it} from "vitest";
import {verifyResendWebhookSignature} from "./resend-webhook";

const secretBytes = Buffer.alloc(32, 255);
const secret = "whsec_" + secretBytes.toString("base64");
const now = 1_800_000_000;
const body = JSON.stringify({type:"email.delivered",data:{email_id:"email_123"}});

function headers(timestamp = String(now), payload = body) {
  const id = "msg_abc-123";
  const signature = createHmac("sha256", secretBytes)
    .update(id + "." + timestamp + "." + payload)
    .digest("base64");
  return {id,timestamp,signature:"v1,"+signature};
}

describe("Resend webhook signatures",()=>{
  it("verifies a valid signed payload",()=>{
    const h=headers();
    expect(verifyResendWebhookSignature(body,{id:h.id,timestamp:h.timestamp,signature:h.signature},secret,now)).toBe(true);
  });
  it("rejects a changed body",()=>{
    const h=headers();
    expect(verifyResendWebhookSignature(body+" ",{id:h.id,timestamp:h.timestamp,signature:h.signature},secret,now)).toBe(false);
  });
  it("rejects stale timestamps and malformed secrets",()=>{
    const h=headers(String(now-301));
    expect(verifyResendWebhookSignature(body,{id:h.id,timestamp:h.timestamp,signature:h.signature},secret,now)).toBe(false);
    const fresh=headers();
    expect(verifyResendWebhookSignature(body,{id:fresh.id,timestamp:fresh.timestamp,signature:fresh.signature},"invalid",now)).toBe(false);
  });
  it("supports multiple signature versions in one header",()=>{
    const h=headers();
    expect(verifyResendWebhookSignature(body,{id:h.id,timestamp:h.timestamp,signature:"v0,invalid v1,"+h.signature.slice(3)},secret,now)).toBe(true);
  });
});
