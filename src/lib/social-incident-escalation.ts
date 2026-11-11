export function getSocialIncidentEscalationPage<T extends {id:string}>(memberships:T[],pageSize:number):{recipients:T[];hasMore:boolean;nextCursor:string|null}{
  if(!Number.isInteger(pageSize)||pageSize<1)throw new Error("INVALID_ESCALATION_PAGE_SIZE");
  const hasMore=memberships.length>pageSize;
  const recipients=memberships.slice(0,pageSize);
  return {recipients,hasMore,nextCursor:hasMore?recipients[recipients.length-1]?.id??null:null};
}
