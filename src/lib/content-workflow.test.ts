import {describe,expect,it} from "vitest";
import {canTransitionContent,contentWorkflowTransitions} from "./content-workflow";

describe("content workflow",()=>{
  it("allows the forward editorial path",()=>{
    expect(canTransitionContent("IDEA","DRAFT")).toBe(true);
    expect(canTransitionContent("DRAFT","REVIEW")).toBe(true);
    expect(canTransitionContent("REVIEW","APPROVED")).toBe(true);
    expect(canTransitionContent("APPROVED","SCHEDULED")).toBe(true);
    expect(canTransitionContent("SCHEDULED","PUBLISHED")).toBe(true);
  });
  it("allows explicit review and failure recovery paths",()=>{
    expect(canTransitionContent("REVIEW","DRAFT")).toBe(true);
    expect(canTransitionContent("SCHEDULED","FAILED")).toBe(true);
    expect(canTransitionContent("FAILED","DRAFT")).toBe(true);
    expect(canTransitionContent("SCHEDULED","APPROVED")).toBe(true);
  });
  it("rejects skipped or terminal transitions",()=>{
    expect(canTransitionContent("IDEA","APPROVED")).toBe(false);
    expect(canTransitionContent("DRAFT","PUBLISHED")).toBe(false);
    expect(canTransitionContent("PUBLISHED","DRAFT")).toBe(false);
    expect(contentWorkflowTransitions.PUBLISHED).toHaveLength(0);
  });
});
