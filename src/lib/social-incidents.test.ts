import {describe,expect,it} from "vitest";
import {getSocialIncidentEscalationPage} from "./social-incidents";

describe("getSocialIncidentEscalationPage",()=>{
  it("returns a bounded page and cursor when more recipients remain",()=>{
    const memberships=Array.from({length:4},(_,index)=>({id:"member-"+(index+1)}));
    expect(getSocialIncidentEscalationPage(memberships,3)).toEqual({
      recipients:memberships.slice(0,3),hasMore:true,nextCursor:"member-3",
    });
  });

  it("marks the final page complete without retaining a cursor",()=>{
    const memberships=[{id:"member-1"},{id:"member-2"}];
    expect(getSocialIncidentEscalationPage(memberships,3)).toEqual({
      recipients:memberships,hasMore:false,nextCursor:null,
    });
  });

  it("returns an empty final page safely",()=>{
    expect(getSocialIncidentEscalationPage([],50)).toEqual({recipients:[],hasMore:false,nextCursor:null});
  });

  it("rejects invalid page sizes",()=>{
    expect(()=>getSocialIncidentEscalationPage([{id:"member-1"}],0)).toThrow("INVALID_ESCALATION_PAGE_SIZE");
    expect(()=>getSocialIncidentEscalationPage([{id:"member-1"}],1.5)).toThrow("INVALID_ESCALATION_PAGE_SIZE");
  });
});
