import { tokens, similarity } from "./shadow-outcomes.js";
import type { Episode } from "./brain-episodes.js";
import type { Lesson, LessonBook } from "./brain-labeler.js";
import type { Catalyst, Regime } from "./brain-regime.js";

/**
 * Experience retrieval before every Sol decision: the most similar past episodes
 * (wording, catalyst, storyline, regime, session, source tier), weighted toward
 * recent history and toward the regime that is active now, plus the lessons that
 * apply to this catalyst/regime.
 */
export type ExperienceQuery = { fact: string; catalyst: Catalyst; storyKey: string; regime?: Regime; session: string; tier: number; now: number; excludeId?: string };
export type RetrievalWeights = { halfLifeDays: number; regimeBoost: number };
export type Retrieved = { episode: Episode; score: number };

export function retrieveEpisodes(episodes: Episode[], q: ExperienceQuery, w: RetrievalWeights = { halfLifeDays: 30, regimeBoost: 1.5 }, limit = 6): Retrieved[] {
  const mine = tokens(q.fact);
  const out: Retrieved[] = [];
  for (const e of episodes) {
    if (e.id === q.excludeId || !e.label || !e.reviewed) continue;
    const age = q.now - Date.parse(e.at);
    if (age < 10 * 60_000 || age > 365 * 86400_000) continue;
    const text = mine.size >= 3 ? similarity(mine, tokens(e.fact)) : 0;
    const base = 0.45 * text + 0.2 * (e.catalyst === q.catalyst ? 1 : 0) + 0.15 * (e.storyKey === q.storyKey ? 1 : 0)
      + 0.1 * (q.regime && e.regime?.primary === q.regime ? 1 : 0) + 0.05 * (e.session === q.session ? 1 : 0) + 0.05 * (e.tier === q.tier ? 1 : 0);
    if (base < 0.3) continue;
    const recency = Math.pow(0.5, age / 86400_000 / w.halfLifeDays);
    const regime = q.regime && e.regime?.primary === q.regime ? w.regimeBoost : 1;
    out.push({ episode: e, score: base * (0.35 + 0.65 * recency) * regime });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function relevantLessons(book: LessonBook, catalyst: Catalyst, regime: Regime | undefined, limit = 4): Lesson[] {
  return book.all().filter((l) => l.catalyst === catalyst && (!regime || l.regime === regime || l.support >= 3))
    .sort((a, b) => book.strength(b) * Math.log2(b.support + 1) - book.strength(a) * Math.log2(a.support + 1)).slice(0, limit);
}

const pct = (v?: number) => v === undefined ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
export function experiencePack(found: Retrieved[], lessons: Lesson[], book: LessonBook, now: number): string {
  if (!found.length && !lessons.length) return "EXPERIENCE_PACK: belum ada pengalaman mirip yang sudah dinilai; putuskan dari bukti sekarang saja.";
  const lines = found.map(({ episode: e, score }) => {
    const days = Math.round((now - Date.parse(e.at)) / 86400_000);
    return `- ${days}h lalu | ${e.catalyst}/${e.storyKey} | rezim ${e.regime?.primary ?? "?"} | ${e.published ? "terkirim" : "ditolak"} | ${e.title.replace(/\s+/g, " ").slice(0, 100)}` +
      ` | keputusan ${e.decision ? `${e.decision.direction} ${e.decision.confidence}% → ${e.finalAction}` : "tidak ada"} | XAU 15m ${pct(e.marks["15"]?.moves.XAU)}, 1j ${pct(e.marks["60"]?.moves.XAU)}, 4j ${pct(e.marks["240"]?.moves.XAU)}` +
      ` | DXY 1j ${pct(e.marks["60"]?.moves.DXY)} | hasil ${e.label?.label}${e.label?.final ? "" : " (sementara)"} | skor ${score.toFixed(2)}`;
  });
  const lessonLines = lessons.map((l) => `- [${l.errorType}, terjadi ${l.support}x, dibantah ${l.contradict}x, bobot ${book.strength(l).toFixed(2)}] ${l.solText ?? l.text}${l.conditions ? ` (berlaku: ${l.conditions})` : ""}`);
  return [found.length ? `EXPERIENCE_PACK (episode masa lalu paling mirip, sudah dinilai):\n${lines.join("\n")}` : "EXPERIENCE_PACK: tidak ada episode mirip.",
    lessonLines.length ? `LESSONS (pelajaran tersimpan untuk katalis ini):\n${lessonLines.join("\n")}` : ""].filter(Boolean).join("\n");
}

export const EXPERIENCE_GUIDE = `EXPERIENCE REASONING (uses REGIME, EXPERIENCE_PACK and LESSONS when supplied; evidence, never rules):
Before deciding, compare this item with the listed past episodes: same catalyst and storyline, what the brain decided then, and how XAU, DXY and yields actually reacted. Weight recent episodes and episodes from the current regime more; a pattern from a different regime may not apply. In bedaDenganMasaLalu state in one or two Indonesian sentences the most important difference between now and the closest past case (regime, pre-move, source, surprise size) and whether the old pattern still applies. Apply LESSONS whose conditions match; a lesson seen once is a caution, a lesson repeated several times with few contradictions should change confidence or action. Never invent past episodes, reactions or lessons that are not listed.`;
