import { existsSync, mkdirSync, openSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewRecord } from "./intelligence-store.js";

/**
 * Coverage audit: separates "never found" from "found but rejected/held" and shows the
 * funnel source → filter → Sol → format → Telegram with the reasons items stopped.
 * Read-only over the raw archive (everything fetched) and the decision records.
 */
export type ArchiveEntry = { fetchedAt: string; provider: string; item: { title?: string; summary?: string; url?: string; providerId?: string; publishedAt?: string; sourceName?: string } };
export type TraceStatus = "TERKIRIM" | "DITAHAN" | "DITOLAK" | "DUPLIKAT" | "DITEMUKAN_BELUM_DIPROSES" | "TIDAK_DITEMUKAN";

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "after", "over", "says", "said", "will", "its", "are", "was", "has", "have", "been", "than", "more", "amid", "but", "not", "you", "new", "yang", "dan", "dari", "untuk", "dengan", "ini", "itu", "just", "breaking", "report", "reports"]);
export function tokens(text: string): string[] {
  return [...new Set(text.toLowerCase().replace(/&#39;|&amp;|&quot;/g, " ").replace(/(\d),(\d)/g, "$1$2").match(/[a-z]{3,}|\d+(?:\.\d+)?/g) ?? [])].filter((t) => !STOP.has(t));
}
/** Share of the query's significant words found in the candidate; numbers in the query must match when present. */
export function similarity(query: string[], candidate: string[]): number {
  if (!query.length) return 0;
  const set = new Set(candidate);
  const hits = query.filter((t) => set.has(t)).length;
  const numbers = query.filter((t) => /^\d/.test(t) && t.length > 1);
  const numberOk = !numbers.length || numbers.some((n) => set.has(n));
  return numberOk ? hits / query.length : (hits / query.length) * 0.5;
}
export function statusOf(r: ReviewRecord): Exclude<TraceStatus, "TIDAK_DITEMUKAN" | "DITEMUKAN_BELUM_DIPROSES"> {
  if (r.stage === "SENT") return "TERKIRIM";
  if (r.stage === "DUPLICATE") return "DUPLIKAT";
  if (["SOURCE", "CRITIC", "FORMAT", "ROUTING", "AI_CONTRACT_FAILURE", "SHADOW"].includes(r.stage)) return "DITAHAN";
  return "DITOLAK";
}
const RANK: Record<TraceStatus, number> = { TERKIRIM: 6, DITAHAN: 5, DITOLAK: 4, DUPLIKAT: 3, DITEMUKAN_BELUM_DIPROSES: 2, TIDAK_DITEMUKAN: 1 };
const reasonCode = (reason: string) => reason.split(/[:;(]/)[0].trim().slice(0, 60);

/** Reads the last `days` daily JSONL files (tail-capped per file), unique by provider+id. */
export function readArchive(dir: string, now = new Date(), days = 2, maxBytes = 40_000_000): ArchiveEntry[] {
  const seen = new Map<string, ArchiveEntry>();
  for (let d = days - 1; d >= 0; d--) {
    const file = join(dir, `${new Date(now.getTime() - d * 86400_000).toISOString().slice(0, 10)}.jsonl`);
    if (!existsSync(file)) continue;
    const size = statSync(file).size, start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start); const fd = openSync(file, "r"); readSync(fd, buf, 0, buf.length, start); closeSync(fd);
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.startsWith("{")) continue;
      try { const e = JSON.parse(line) as ArchiveEntry; const key = `${e.provider}|${e.item?.providerId ?? e.item?.url ?? e.item?.title}`; if (!seen.has(key)) seen.set(key, e); } catch { /* partial line */ }
    }
  }
  return [...seen.values()];
}

export type TraceMatch = { provider: string; title: string; fetchedAt: string; status: TraceStatus; stage?: string; reason?: string; tier?: number; ref?: string; score: number };
/** Where did this headline go? Looks in everything fetched, then in the decisions. */
export function traceHeadline(query: string, archive: ArchiveEntry[], records: ReviewRecord[], min = 0.6): { status: TraceStatus; matches: TraceMatch[] } {
  const q = tokens(query);
  const byId = new Map(records.map((r) => [`${r.article.provider}|${r.article.providerId}`, r]));
  const byTitle = new Map(records.map((r) => [r.article.title.trim().toLowerCase(), r]));
  const matches: TraceMatch[] = [];
  for (const e of archive) {
    const title = e.item?.title ?? "";
    const score = similarity(q, tokens(`${title} ${(e.item?.summary ?? "").slice(0, 300)}`));
    if (score < min || q.length < 2) continue;
    const r = byId.get(`${e.provider}|${e.item?.providerId}`) ?? byTitle.get(title.trim().toLowerCase());
    matches.push({ provider: e.provider, title: title.slice(0, 140), fetchedAt: e.fetchedAt, score: +score.toFixed(2),
      status: r ? statusOf(r) : "DITEMUKAN_BELUM_DIPROSES", stage: r?.stage, reason: r ? reasonCode(r.reason) : undefined, tier: r?.event.sourceTier, ref: r?.id.slice(0, 10) });
  }
  matches.sort((a, b) => RANK[b.status] - RANK[a.status] || b.score - a.score || a.fetchedAt.localeCompare(b.fetchedAt));
  return { status: matches[0]?.status ?? "TIDAK_DITEMUKAN", matches: matches.slice(0, 8) };
}
export function formatTrace(query: string, t: ReturnType<typeof traceHeadline>): string {
  if (t.status === "TIDAK_DITEMUKAN") return `CEK: "${query.slice(0, 120)}"\nStatus: TIDAK DITEMUKAN — tidak ada sumber bot yang mengambil berita ini dalam 2 hari. Masalahnya di cakupan sumber, bukan di Sol.`;
  return [`CEK: "${query.slice(0, 120)}"`, `Status: ${t.status.replace(/_/g, " ")}`,
    ...t.matches.map((m) => `• [${m.provider}${m.tier ? ` · tier ${m.tier}` : ""}] ${m.title}\n  → ${m.status}${m.stage ? ` di tahap ${m.stage}` : ""}${m.reason ? ` (${m.reason})` : ""}${m.ref ? ` · ref ${m.ref}` : ""} · ${m.fetchedAt.slice(11, 16)}Z`)].join("\n");
}

export type Funnel = {
  day: string;
  providers: Array<{ provider: string; fetched: number; toSol: number; sent: number; held: number }>;
  stages: { fetched: number; decided: number; passedFilter: number; judgedBySol: number; solMaterial: number; passedFormat: number; sent: number };
  held: Record<string, number>; rejected: Record<string, number>; withFacts: number; headlineOnly: number;
  heldSamples: Array<{ ref: string; stage: string; reason: string; title: string }>;
};
const inDay = (iso: string | undefined, day: string) => Boolean(iso && new Date(Date.parse(iso)).toISOString().slice(0, 10) === day);
export function funnel(day: string, archive: ArchiveEntry[], records: ReviewRecord[]): Funnel {
  const fetched = archive.filter((e) => e.fetchedAt.slice(0, 10) === day);
  const recs = records.filter((r) => inDay(r.sentAt ?? String(r.article.publishedAt), day));
  const providers = [...new Set(fetched.map((e) => e.provider))].sort().map((provider) => {
    const own = recs.filter((r) => r.article.provider === provider);
    return { provider, fetched: fetched.filter((e) => e.provider === provider).length, toSol: own.filter((r) => r.audit?.aiCalled).length,
      sent: own.filter((r) => r.stage === "SENT").length, held: own.filter((r) => statusOf(r) === "DITAHAN").length };
  });
  const count = (xs: ReviewRecord[]) => xs.reduce<Record<string, number>>((m, r) => { const k = `${r.stage}: ${reasonCode(r.reason)}`; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const held = recs.filter((r) => statusOf(r) === "DITAHAN"), rejected = recs.filter((r) => statusOf(r) === "DITOLAK");
  const judged = recs.filter((r) => r.audit?.aiCalled);
  const material = judged.filter((r) => r.primaryDecision === "SEND" || r.shadowDecision === "SEND" || ["FORMAT", "CRITIC", "ROUTING", "SENT", "SOURCE"].includes(r.stage));
  return {
    day, providers,
    stages: { fetched: fetched.length, decided: recs.filter((r) => r.stage !== "DUPLICATE").length, passedFilter: recs.filter((r) => r.audit?.prefilter === "REVIEW" && r.stage !== "DUPLICATE").length,
      judgedBySol: judged.length, solMaterial: material.length, passedFormat: recs.filter((r) => ["CRITIC", "ROUTING", "SENT"].includes(r.stage)).length, sent: recs.filter((r) => r.stage === "SENT").length },
    held: count(held), rejected: count(rejected),
    withFacts: judged.filter((r) => r.factsStatus === "FULL").length, headlineOnly: judged.filter((r) => r.factsStatus === "HEADLINE_ONLY").length,
    heldSamples: held.slice(-10).map((r) => ({ ref: r.id.slice(0, 10), stage: r.stage, reason: reasonCode(r.reason), title: r.article.title.slice(0, 100) }))
  };
}
const top = (m: Record<string, number>, n = 6) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `  ${v}× ${k}`).join("\n") || "  (tidak ada)";
export function formatFunnel(f: Funnel, audit?: ReferenceAudit): string {
  const s = f.stages;
  return [`CORONG CAKUPAN ${f.day} (UTC)`,
    `Sumber ${s.fetched} item unik → diputuskan ${s.decided} → lolos filter ${s.passedFilter} → dinilai Sol ${s.judgedBySol} → Sol anggap penting ${s.solMaterial} → lolos format ${s.passedFormat} → TERKIRIM ${s.sent}`,
    `Fakta ke Sol: ${f.withFacts} dengan isi artikel, ${f.headlineOnly} hanya judul/ringkasan pendek`,
    `Per sumber (ambil / ke Sol / terkirim / ditahan):\n${f.providers.map((p) => `  ${p.provider}: ${p.fetched} / ${p.toSol} / ${p.sent} / ${p.held}`).join("\n") || "  (kosong)"}`,
    `Alasan DITAHAN terbanyak:\n${top(f.held)}`, `Alasan DITOLAK terbanyak:\n${top(f.rejected)}`,
    f.heldSamples.length ? `Contoh ditahan (cek pakai /fn ref alasan kalau harusnya masuk):\n${f.heldSamples.map((h) => `  ${h.ref} [${h.stage} ${h.reason}] ${h.title}`).join("\n")}` : "",
    audit ? formatReferenceAudit(audit) : ""].filter(Boolean).join("\n\n");
}

/** Independent reference sample: headlines from narrow searches, traced against what the bot fetched and decided. */
export type ReferenceAudit = { total: number; byStatus: Record<string, number>; missing: string[]; rejected: string[] };
export const AUDIT_QUERIES = ["gold price", "Federal Reserve rate", "US inflation CPI OR PCE", "US jobs payrolls OR jobless claims", "Treasury yields dollar", "oil prices Iran OR OPEC OR Houthi", "central bank gold buying", "tariffs trade war"];
const GOLD_RELEVANT = /\b(gold|bullion|fed|fomc|powell|rate|inflation|cpi|pce|ppi|payroll|jobless|jobs|unemployment|gdp|pmi|yield|treasur|dollar|oil|opec|iran|israel|houthi|tariff|sanction|central bank|war|ceasefire)/i;
export function referenceAudit(reference: Array<{ title: string }>, archive: ArchiveEntry[], records: ReviewRecord[]): ReferenceAudit {
  const uniq = new Map<string, string>();
  for (const r of reference) { const t = r.title.replace(/\s+-\s+[^-]+$/, "").trim(); if (GOLD_RELEVANT.test(t) && !uniq.has(t.toLowerCase())) uniq.set(t.toLowerCase(), t); }
  const items = [...uniq.values()].slice(0, 60);
  const byStatus: Record<string, number> = {}; const missing: string[] = []; const rejected: string[] = [];
  for (const title of items) {
    const t = traceHeadline(title, archive, records, 0.55);
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    if (t.status === "TIDAK_DITEMUKAN") missing.push(title.slice(0, 110));
    else if (t.status === "DITOLAK" || t.status === "DITAHAN") rejected.push(`${title.slice(0, 90)} → ${t.matches[0].stage} ${t.matches[0].reason ?? ""}`.trim());
  }
  return { total: items.length, byStatus, missing: missing.slice(0, 12), rejected: rejected.slice(0, 12) };
}
export function formatReferenceAudit(a: ReferenceAudit): string {
  const pct = (k: string) => a.total ? Math.round(((a.byStatus[k] ?? 0) / a.total) * 100) : 0;
  const found = a.total - (a.byStatus.TIDAK_DITEMUKAN ?? 0);
  return [`AUDIT SAMPEL LUAR (${a.total} judul relevan dari pencarian 24 jam, bukan dari sumber bot):`,
    `  Ditemukan bot: ${found}/${a.total} (${a.total ? Math.round((found / a.total) * 100) : 0}%) · terkirim ${pct("TERKIRIM")}% · ditahan ${pct("DITAHAN")}% · ditolak ${pct("DITOLAK")}% · duplikat ${pct("DUPLIKAT")}%`,
    a.missing.length ? `  TIDAK DITEMUKAN (lubang sumber):\n${a.missing.map((m) => `   - ${m}`).join("\n")}` : "",
    a.rejected.length ? `  DITEMUKAN TAPI DITOLAK/DITAHAN (cek apakah harusnya masuk):\n${a.rejected.map((m) => `   - ${m}`).join("\n")}` : "",
    "  Catatan: sampel ini tidak otomatis berarti wajib jadi alert; banyak judul memang bukan penggerak emas."].filter(Boolean).join("\n");
}
export function saveReport(dir: string, day: string, text: string): void {
  try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${day}.txt`), text, "utf8"); } catch { /* report persistence is best-effort */ }
}
