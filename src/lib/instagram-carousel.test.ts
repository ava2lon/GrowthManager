import {describe, expect, it} from "vitest";
import {parseInstagramCarouselState} from "./instagram-carousel-utils";

describe("Instagram carousel persisted state", () => {
  it("accepts a valid initial state", () => {
    expect(parseInstagramCarouselState({
      instagramCarousel: {
        version: 1,
        phase: "CREATE_CHILDREN",
        childIds: [],
        childIndex: 0,
        startedAt: "2026-11-08T12:00:00.000Z",
      },
    })).toMatchObject({
      version: 1,
      phase: "CREATE_CHILDREN",
      childIds: [],
      childIndex: 0,
    });
  });

  it("rejects missing, unsupported, and malformed state", () => {
    expect(parseInstagramCarouselState(null)).toBeNull();
    expect(parseInstagramCarouselState({})).toBeNull();
    expect(parseInstagramCarouselState({instagramCarousel: {version: 2}})).toBeNull();
    expect(parseInstagramCarouselState({
      instagramCarousel: {
        version: 1,
        phase: "UNSUPPORTED",
        childIds: [],
        childIndex: 0,
        startedAt: "2026-11-08T12:00:00.000Z",
      },
    })).toBeNull();
    expect(parseInstagramCarouselState({
      instagramCarousel: {
        version: 1,
        phase: "CREATE_CHILDREN",
        childIds: ["valid", 42],
        childIndex: 0,
        startedAt: "2026-11-08T12:00:00.000Z",
      },
    })).toBeNull();
    expect(parseInstagramCarouselState({
      instagramCarousel: {
        version: 1,
        phase: "CREATE_CHILDREN",
        childIds: [],
        childIndex: -1,
        startedAt: "2026-11-08T12:00:00.000Z",
      },
    })).toBeNull();
    expect(parseInstagramCarouselState({
      instagramCarousel: {
        version: 1,
        phase: "CREATE_CHILDREN",
        childIds: [],
        childIndex: 0,
        childRequestStarted: "yes",
        startedAt: "2026-11-08T12:00:00.000Z",
      },
    })).toBeNull();
    expect(parseInstagramCarouselState({
      instagramCarousel: {
        version: 1,
        phase: "CREATE_CHILDREN",
        childIds: [],
        childIndex: 0,
        startedAt: "not-a-date",
      },
    })).toBeNull();
  });
});
