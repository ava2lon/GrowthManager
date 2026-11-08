export type InstagramCarouselState = {
  version: 1;
  phase: "CREATE_CHILDREN" | "POLL_CHILDREN" | "CREATE_PARENT" | "POLL_PARENT" | "PUBLISH" | "PUBLISH_REQUEST_STARTED";
  childIds: string[];
  childIndex: number;
  childRequestStarted?: boolean;
  parentId?: string;
  startedAt: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseInstagramCarouselState(value: unknown): InstagramCarouselState | null {
  const state = record(record(value).instagramCarousel);
  const phases = ["CREATE_CHILDREN", "POLL_CHILDREN", "CREATE_PARENT", "POLL_PARENT", "PUBLISH", "PUBLISH_REQUEST_STARTED"];
  if (
    state.version !== 1 ||
    !phases.includes(String(state.phase)) ||
    !Array.isArray(state.childIds) ||
    !state.childIds.every((id) => typeof id === "string" && id.length > 0) ||
    typeof state.childIndex !== "number" ||
    !Number.isInteger(state.childIndex) ||
    state.childIndex < 0 ||
    (state.childRequestStarted !== undefined && typeof state.childRequestStarted !== "boolean") ||
    (state.parentId !== undefined && (typeof state.parentId !== "string" || state.parentId.length === 0)) ||
    typeof state.startedAt !== "string" ||
    Number.isNaN(Date.parse(state.startedAt))
  ) {
    return null;
  }

  return state as unknown as InstagramCarouselState;
}
