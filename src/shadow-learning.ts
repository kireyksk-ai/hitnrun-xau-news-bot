/** Persistent-data-compatible, deterministic shadow learning primitives. */
export type Horizon='INTRADAY'|'TACTICAL'|'STRUCTURAL'; export type Attribution='CONFIRMED_DRIVER'|'LIKELY_DRIVER'|'POSSIBLE_DRIVER'|'MULTIPLE_COMPETING_DRIVERS'|'INSUFFICIENT_EVIDENCE'|'DRIVER_UNKNOWN';
export type SourceReputation={observations:number; confirmed:number; corrections:number; noise:number; materialDiscoveries:number};
export function sourceWeight(r:SourceReputation, prior=0.5):number { const n=r.observations; return (prior*10+(r.confirmed+0.5*r.materialDiscoveries)/(Math.max(1,n)+1)*n)/(10+n); }
export function sourceUsefulness(r:SourceReputation):'INSUFFICIENT_SAMPLE'|'USEFUL'|'NO_EDGE_FOUND' { if(r.observations<20)return 'INSUFFICIENT_SAMPLE'; return r.materialDiscoveries/r.observations>=0.05?'USEFUL':'NO_EDGE_FOUND'; }
export type DelayedOutcome={eventId:string; horizon:Horizon; dueAt:string; attribution:Attribution; outcome?:'MARKET_CONFIRMATION'|'NO_EFFECT'|'CONTRADICTED'};
export function outcomeAttribution(observed:boolean, contradicted:boolean, sampleSize:number):Attribution { if(sampleSize<20)return 'INSUFFICIENT_EVIDENCE'; if(contradicted)return 'MULTIPLE_COMPETING_DRIVERS'; return observed?'POSSIBLE_DRIVER':'DRIVER_UNKNOWN'; }
export function walkForwardAllowed(train:number,test:number,embargo:number):boolean{return train>=40&&test>=20&&embargo>=0;}
