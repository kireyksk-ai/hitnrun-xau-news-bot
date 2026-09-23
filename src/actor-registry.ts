import type { SourceClass } from "./types.js";

/** Only confidently identified accounts belong here. Unknown handles stay unverified. */
export type ActorRegistryEntry = { username: string; sourceClass: SourceClass; actor: string; direct: boolean };
export const ACTOR_REGISTRY: readonly ActorRegistryEntry[] = [
  { username: "DeItaone", sourceClass: "FAST_WIRE", actor: "DeltaOne", direct: false },
  { username: "FirstSquawk", sourceClass: "FAST_WIRE", actor: "FirstSquawk", direct: false },
  { username: "LiveSquawk", sourceClass: "FAST_WIRE", actor: "LiveSquawk", direct: false },
  { username: "financialjuice", sourceClass: "FAST_WIRE", actor: "FinancialJuice", direct: false },
  { username: "zerohedge", sourceClass: "SECONDARY_REPORT", actor: "ZeroHedge", direct: false },
  { username: "unusual_whales", sourceClass: "SECONDARY_REPORT", actor: "Unusual Whales", direct: false },
  { username: "WatcherGuru", sourceClass: "SECONDARY_REPORT", actor: "WatcherGuru", direct: false },
  // Bloomberg's official newsroom accounts: headline + link only; Sol writes its own narrative.
  { username: "business", sourceClass: "CREDIBLE_REPORTER", actor: "Bloomberg", direct: false },
  { username: "markets", sourceClass: "CREDIBLE_REPORTER", actor: "Bloomberg Markets", direct: false },
  { username: "economics", sourceClass: "CREDIBLE_REPORTER", actor: "Bloomberg Economics", direct: false },
  { username: "BloombergTV", sourceClass: "CREDIBLE_REPORTER", actor: "Bloomberg TV", direct: false }
] as const;

export function sourceClassFor(username?: string): SourceClass {
  return runtimeActorRegistry().find((item) => item.username.toLowerCase() === username?.toLowerCase())?.sourceClass ?? "UNVERIFIED_CLAIM";
}

/** Optional operator-supplied entries; malformed/unclassified handles are ignored. */
export function runtimeActorRegistry(raw = process.env.X_ACTOR_REGISTRY_JSON): readonly ActorRegistryEntry[] {
  if (!raw) return ACTOR_REGISTRY;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return ACTOR_REGISTRY;
    const valid = parsed.filter((x): x is ActorRegistryEntry => Boolean(x) && typeof x === "object" &&
      typeof (x as ActorRegistryEntry).username === "string" && /^[A-Za-z0-9_]{1,15}$/.test((x as ActorRegistryEntry).username) &&
      ["OFFICIAL_DIRECT_STATEMENT", "CREDIBLE_REPORTER", "FAST_WIRE", "SECONDARY_REPORT", "UNVERIFIED_CLAIM", "OPINION", "NOISE"].includes((x as ActorRegistryEntry).sourceClass) &&
      typeof (x as ActorRegistryEntry).actor === "string" && typeof (x as ActorRegistryEntry).direct === "boolean");
    return [...ACTOR_REGISTRY, ...valid];
  } catch { return ACTOR_REGISTRY; }
}
