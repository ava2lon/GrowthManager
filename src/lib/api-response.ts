import {randomUUID} from "node:crypto";

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PROVIDER_ERROR"
  | "INTERNAL_ERROR";

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode;
    message: string;
    request_id: string;
  };
};

export function createRequestId(): string {
  return randomUUID();
}

export function apiErrorResponse(
  code: ApiErrorCode,
  message: string,
  status: number,
  requestId = createRequestId(),
): Response {
  const body: ApiErrorBody = {
    error: {
      code,
      message,
      request_id: requestId,
    },
  };

  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
    },
  });
}

export function internalApiErrorResponse(requestId = createRequestId()): Response {
  return apiErrorResponse(
    "INTERNAL_ERROR",
    "An unexpected error occurred.",
    500,
    requestId,
  );
}
