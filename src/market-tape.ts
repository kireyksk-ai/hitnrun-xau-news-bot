/** Deterministic, shadow-only measurements. No prediction or Telegram routing. */
export type Candle = { open:number; high:number; low:number; close:number; capturedAt:string; session:string; quality:"FRESH"|"STALE"|"DATA_UNAVAILABLE" };
export type CandleAnatomy = Candle & { range:number; body:number; bodyRangeRatio:number; upperWick:number; lowerWick:number; closeLocation:number; returnPct:number };
export function anatomy(c: Candle): CandleAnatomy {
  const range=Math.max(0,c.high-c.low), body=Math.abs(c.close-c.open);
  return {...c,range,body,bodyRangeRatio:range?body/range:0,upperWick:Math.max(0,c.high-Math.max(c.open,c.close)),lowerWick:Math.max(0,Math.min(c.open,c.close)-c.low),closeLocation:range?(c.close-c.low)/range:0,returnPct:c.open?(c.close-c.open)/c.open*100:0};
}
export function rangePercentile(current:number, history:number[]): { percentile:number|null; sampleSize:number; state:"OK"|"INSUFFICIENT_SAMPLE" } {
  if(history.length<20) return {percentile:null,sampleSize:history.length,state:"INSUFFICIENT_SAMPLE"};
  return {percentile:history.filter(x=>x<=current).length/history.length*100,sampleSize:history.length,state:"OK"};
}
