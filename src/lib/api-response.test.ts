import {describe, expect, it} from "vitest";
import {
  apiErrorResponse,
  createRequestId,
  internalApiErrorResponse,
} from "./api-response";

describe("API error responses", () => {
  it("returns the documented error envelope and request ID", async () => {
    const requestId = createRequestId();
    const response = apiErrorResponse(
      "VALIDATION_ERROR",
      "Invalid request",
      400,
      requestId,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("X-Request-Id")).toBe(requestId);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request",
        request_id: requestId,
      },
    });
  });

  it("generates UUID request identifiers", () => {
    expect(createRequestId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("does not expose internal exception details", async () => {
    const response = internalApiErrorResponse("request-123");
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
        request_id: "request-123",
      },
    });
  });
});
