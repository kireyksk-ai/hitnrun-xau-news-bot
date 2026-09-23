import pino from "pino";
import type { NewsArticle, EditorialDecision } from "./types.js";
import type { EventAssessment } from "./event-intelligence.js";
import type { IntelligenceStore, ReviewRecord } from "./intelligence-store.js";
import type { Editor } from "./editor.js";
import { dataHealth, type DataHealth } from "./brain-market.js";
import { catalystOf, evaluateRegime, regimeBars, regimeBrief, RegimeLedger, type Catalyst } from "./brain-regime.js";
import { credibilityOf, dueMarks, EpisodeLedger, marketContextAt, regimeStamp, takeMark, type CriticResult, type Episode } from "./brain-episodes.js";
import { ERROR_LABELS, labelEpisode, LessonBook } from "./brain-labeler.js";
import { experiencePack, relevantLessons, retrieveEpisodes } from "./brain-retrieval.js";
import { finalizeAction } from "./brain-decision.js";
import { formatMetrics, metrics, tradesOf } from "./brain-eval.js";
import { effectiveAutonomy, PolicyRegistry, riskHalt, type AutonomyLevel } from "./brain-policy.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

export type BrainConfig = {
  basePath: string; autonomy: AutonomyLevel; killSwitch: boolean; aiCallsPerDay: number;
  dailyLossPct: number; maxDrawdownPct: number; approve?: string; rollbackTo?: string;
  report: (text: string) => Promise<void>; advisory?: (text: string) => Promise<void>;
};

/**
 * Market Brain orchestrator: closed learning loop.
 * news → context (regime + experience + lessons) → Sol decision → critic → episode →
 * market reacts (marks) → outcome label → lesson → used again in the next decision;
 * plus continuous evaluation and versioned policy candidates.
 */
export class MarketBrain {
  readonly episodes: EpisodeLedger; readonly lessons: LessonBook; readonly regime: RegimeLedger; readonly policy: PolicyRegistry;
  private retrievalCache = new Map<string, { episodeIds: string[]; lessonKeys: string[] }>();
  private aiDay = ""; private aiUsed = 0;
  private lastRegimeAt = 0; private lastMarkAt = 0; private lastDaily = ""; private lastWeekly = ""; private marking = false;
  private halted?: string; private autonomyNote = "";
  constructor(private readonly store: IntelligenceStore, private readonly editor: Editor, private readonly cfg: BrainConfig) {
    this.episodes = new EpisodeLedger(`${cfg.basePath}.episodes.json`);
    this.lessons = new LessonBook(`${cfg.basePath}.lessons.json`);
    this.regime = new RegimeLedger(`${cfg.basePath}.regime.json`);
    this.policy = new PolicyRegistry(`${cfg.basePath}.policy.json`);
    if (cfg.approve) log.info({ result: this.policy.approve(cfg.approve) }, "Brain policy approval requested by owner");
    if (cfg.rollbackTo) log.info({ result: this.policy.rollback(cfg.rollbackTo, "owner POLICY_ROLLBACK_TO") }, "Brain policy rollback requested by owner");
    log.info({ episodes: this.episodes.all().length, lessons: this.lessons.all().length, regime: this.regime.current()?.primary ?? "none",
      policy: this.policy.active().id, autonomy: cfg.autonomy, killSwitch: cfg.killSwitch }, "Market brain loaded");
  }

  private brainAi(): boolean {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.aiDay) { this.aiDay = day; this.aiUsed = 0; }
    if (this.aiUsed >= this.cfg.aiCallsPerDay) return false;
    this.aiUsed++; return true;
  }

  /** Recent material catalysts (48h) feed the regime engine. */
  private catalystCounts(now: number): Partial<Record<Catalyst, number>> {
    const out: Partial<Record<Catalyst, number>> = {};
    for (const r of this.store.records()) {
      if (!r.audit?.aiCalled || Date.parse(r.event.firstSeenAt) < now - 48 * 3600_000) continue;
      const weight = r.stage === "SENT" ? 2 : 1;
      const c = catalystOf(r.event.storyKey, `${r.article.title} ${r.article.summary}`);
      out[c] = (out[c] ?? 0) + weight;
    }
    return out;
  }

  async regimeTick(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastRegimeAt < 15 * 60_000) return;
    this.lastRegimeAt = now;
    const reading = evaluateRegime({ now, bars: await regimeBars(), catalystCounts: this.catalystCounts(now) });
    const shift = this.regime.add(reading);
    this.store.setRegime(this.regime.confirmed() ?? reading.primary);
    log.info({ primary: reading.primary, supporting: reading.supporting, conflicts: reading.conflicts, confidence: reading.confidence,
      dataQuality: reading.dataQuality, top: reading.scores.slice(0, 4).map((s) => `${s.regime}:${s.score}`) }, "Brain regime reading");
    if (shift) log.warn({ shift }, "Brain regime shift confirmed");
  }

  /** Context pack appended to Sol's input: regime + most similar past episodes + applicable lessons. */
  contextFor(event: EventAssessment, article: NewsArticle): string {
    const now = Date.now();
    const current = this.regime.current();
    const knobs = this.policy.active().knobs;
    const catalyst = catalystOf(event.storyKey, `${article.title} ${article.summary}`);
    const found = retrieveEpisodes(this.episodes.all(), { fact: event.fact, catalyst, storyKey: event.storyKey, regime: current?.primary,
      session: sessionOf(now), tier: event.sourceTier, now, excludeId: event.key }, { halfLifeDays: knobs.halfLifeDays, regimeBoost: knobs.regimeBoost });
    const lessons = relevantLessons(this.lessons, catalyst, current?.primary);
    this.retrievalCache.set(event.key, { episodeIds: found.map((f) => f.episode.id), lessonKeys: lessons.map((l) => l.key) });
    if (this.retrievalCache.size > 500) this.retrievalCache.delete(this.retrievalCache.keys().next().value!);
    if (found.length || lessons.length) log.info({ event: event.key.slice(0, 10), catalyst, regime: current?.primary, retrieved: found.map((f) => `${f.episode.id.slice(0, 8)}:${f.episode.label?.label}:${f.score.toFixed(2)}`),
      lessons: lessons.map((l) => l.key) }, "Brain experience retrieved");
    const notes = this.policy.active().notes;
    return [regimeBrief(current), experiencePack(found, lessons, this.lessons, now), notes ? `ACTIVE_POLICY_NOTES (${this.policy.active().id}):\n${notes}` : ""].filter(Boolean).join("\n\n");
  }

  /** Independent second check before publishing, with the real pre-move numbers. */
  async critic(article: NewsArticle, event: EventAssessment, primary: EditorialDecision | undefined, reason: string, allowed: boolean): Promise<CriticResult> {
    if (!allowed) return { verdict: "SKIPPED", reasons: ["anggaran AI habis"], pricedIn: false, preMoved: false, whipsawRisk: "MEDIUM", sourceIssue: false, crossMarketConflict: false };
    const t0 = Date.now();
    const ctx = await marketContextAt(t0).catch(() => undefined);
    const context = [regimeBrief(this.regime.current()),
      ctx ? `PRE_MOVE: XAU 15m ${fmt(ctx.pre.m15.XAU)}, 60m ${fmt(ctx.pre.m60.XAU)}; DXY 15m ${fmt(ctx.pre.m15.DXY)}, 60m ${fmt(ctx.pre.m60.DXY)}; US10Y 60m ${fmt(ctx.pre.m60.US10Y, "bp")}; WTI 60m ${fmt(ctx.pre.m60.WTI)}; realised vol 1m ${ctx.vol60?.toFixed(3) ?? "n/a"}%` : "PRE_MOVE: tidak tersedia",
      `SOURCE: tier ${event.sourceTier}, provider ${article.provider}, ${article.sourceName ?? ""}`].join("\n");
    const result = await Promise.race([
      this.editor.critic({ article: { ...article, summary: article.summary.slice(0, 1500) }, decision: primary?.internal, reason, context }),
      new Promise<CriticResult>((resolve) => setTimeout(() => resolve({ verdict: "SKIPPED", reasons: ["pemeriksa timeout 15 detik"], pricedIn: false, preMoved: false, whipsawRisk: "MEDIUM", sourceIssue: false, crossMarketConflict: false }), 15_000))
    ]);
    log.info({ event: event.key.slice(0, 10), verdict: result.verdict, reasons: result.reasons, pricedIn: result.pricedIn, preMoved: result.preMoved,
      whipsaw: result.whipsawRisk, conflict: result.crossMarketConflict, ms: Date.now() - t0 }, "Brain critic verdict");
    return result;
  }

  /** Every processed (non-duplicate) news item becomes an episode. */
  async onResult(result: ReviewRecord): Promise<void> {
    if (result.stage === "DUPLICATE" || this.episodes.has(result.id)) return;
    const t0 = Date.now();
    const reviewed = Boolean(result.audit?.aiCalled);
    const [ctx, health] = await Promise.all([marketContextAt(t0), reviewed ? dataHealth(t0) : Promise.resolve<DataHealth | undefined>(undefined)]);
    const reading = this.regime.current();
    const policy = this.policy.active();
    const published = result.stage === "SENT";
    const decision = result.brain?.internal;
    const critic = result.brain?.critic;
    const autonomy = this.cfg.autonomy;
    const fin = autonomy === "OBSERVER" ? { action: "NO_TRADE" as const, guardrails: ["mode OBSERVER"] }
      : finalizeAction({ published, decision, critic, health, preMove15: ctx.pre.m15.XAU, killSwitch: this.cfg.killSwitch, halted: this.halted }, policy.knobs);
    const e: Episode = {
      id: result.id, at: new Date(t0).toISOString(), publishedAt: result.article.publishedAt instanceof Date ? result.article.publishedAt.toISOString() : String(result.article.publishedAt),
      title: result.article.title, fact: result.event.fact, provider: result.article.provider, source: result.article.sourceName ?? result.article.provider,
      tier: result.event.sourceTier, credibility: credibilityOf(result.event.sourceTier), storyKey: result.event.storyKey,
      catalyst: catalystOf(result.event.storyKey, `${result.article.title} ${result.article.summary}`), changeType: String(result.event.changeType),
      stage: result.stage, published, outcomeReason: result.reason.slice(0, 240), reviewed,
      session: sessionOf(t0), regime: regimeStamp(reading), narrative: decision?.narrative ?? reading?.dominantNarrative,
      ...ctx, health, decision, critic, finalAction: fin.action, guardrails: fin.guardrails, policyVersion: policy.id,
      retrieval: this.retrievalCache.get(result.id), marks: {}
    };
    this.episodes.upsert(e);
    if (reviewed) log.info({ episode: e.id.slice(0, 10), stage: e.stage, catalyst: e.catalyst, regime: e.regime?.primary, tier: e.tier,
      decision: decision ? `${decision.direction}/${decision.confidence}/${decision.action}` : "none", finalAction: e.finalAction, guardrails: e.guardrails,
      critic: critic?.verdict, preXau15: e.pre.m15.XAU, vol60: e.vol60, retrieved: e.retrieval?.episodeIds.length ?? 0, lessons: e.retrieval?.lessonKeys.length ?? 0,
      health: health?.note, policy: policy.id }, "Brain episode created");
    // Shadow test of a candidate policy's prompt notes on published news (never affects the alert).
    const cand = this.policy.candidate();
    if (cand && cand.notes && cand.notes !== policy.notes && published && this.brainAi()) {
      void this.editor.candidateDecision(result.article, cand.notes).then((c) => {
        const cur = this.episodes.get(e.id); if (!cur) return;
        this.episodes.upsert({ ...cur, candidate: { policyVersion: cand.id, ...c } });
      }).catch((error) => log.warn({ err: error }, "Brain candidate shadow failed"));
    }
    if (this.cfg.advisory && published && (e.finalAction === "BUY" || e.finalAction === "SELL") && this.autonomyNote.startsWith("ADVISORY")) {
      void this.cfg.advisory(`🧠 Penilaian internal (privat): ${e.finalAction} · ${decision?.confidence}% · horizon ${decision?.horizonMinutes}m\n${e.title}\nInvalidasi: ${decision?.invalidation ?? "-"}`).catch(() => undefined);
    }
  }

  /** Every minute: take due marks, label outcomes, learn lessons. */
  async markTick(): Promise<void> {
    const now = Date.now();
    if (this.marking || now - this.lastMarkAt < 60_000) return;
    this.marking = true; this.lastMarkAt = now;
    try {
      const pending = this.episodes.pendingMarks(now).slice(0, 300);
      let taken = 0;
      for (const e of pending) {
        let cur = e;
        for (const m of dueMarks(e, now)) {
          const mark = await takeMark(cur, m, now); if (!mark) continue;
          cur = { ...cur, marks: { ...cur.marks, [`${m}`]: mark } }; taken++;
        }
        const label = labelEpisode(cur, now);
        const changed = label && (!cur.label || cur.label.label !== label.label || cur.label.final !== label.final);
        if (label && changed) {
          cur = { ...cur, label };
          if (cur.reviewed || label.label === "MISSED_MOVE") log.info({ episode: cur.id.slice(0, 10), label: label.label, final: label.final, note: label.note,
            decision: cur.decision ? `${cur.decision.direction}/${cur.decision.confidence}` : "none", finalAction: cur.finalAction, catalyst: cur.catalyst, regime: cur.regime?.primary }, "Brain episode labeled");
          if (label.final) await this.learnFrom(cur);
        }
        if (cur !== e) this.episodes.upsert(cur);
      }
      if (taken) log.info({ marks: taken, pending: pending.length }, "Brain marks taken");
      this.refreshRisk();
    } catch (error) { log.error({ err: error }, "Brain mark tick failed"); }
    finally { this.marking = false; }
  }

  private async learnFrom(e: Episode): Promise<void> {
    if (e.label?.label === "CORRECT") { this.lessons.contradict(e); return; }
    if (!e.label || !(ERROR_LABELS.has(e.label.label) || e.published && e.label.label === "NO_REACTION")) return;
    const learned = this.lessons.learn(e);
    if (!learned) return;
    const upd = this.episodes.get(e.id); if (upd) this.episodes.upsert({ ...upd, label: e.label, lessonKeys: [...new Set([...(upd.lessonKeys ?? []), learned.lesson.key])] });
    log.info({ lesson: learned.lesson.key, created: learned.created, support: learned.lesson.support, text: learned.lesson.text.slice(0, 200) }, "Brain lesson stored");
    // Sol sharpens new lessons and re-sharpens them at 3 and 10 occurrences.
    if ((learned.created || [3, 10].includes(learned.lesson.support)) && (e.reviewed || e.label?.label === "MISSED_MOVE") && this.brainAi()) {
      try {
        const out = await this.editor.lesson({ title: e.title, catalyst: e.catalyst, regime: e.regime, decision: e.decision, critic: e.critic, finalAction: e.finalAction,
          preMove: e.pre, reaction: Object.fromEntries(Object.entries(e.marks).map(([k, v]) => [k, v?.moves])), label: e.label, draft: learned.lesson.text,
          previousExamples: learned.lesson.examples.length });
        this.lessons.refine(learned.lesson.key, out.lesson, out.conditions);
        log.info({ lesson: learned.lesson.key, solText: out.lesson, conditions: out.conditions }, "Brain lesson refined by Sol");
      } catch (error) { log.warn({ err: error }, "Brain lesson refine failed"); }
    }
  }

  private refreshRisk(): void {
    const policy = this.policy.active();
    const trades = tradesOf(this.episodes.all().filter((e) => e.reviewed), policy.knobs.costPct);
    const halt = riskHalt(trades, Date.now(), { dailyLossPct: this.cfg.dailyLossPct, maxDrawdownPct: this.cfg.maxDrawdownPct });
    if (halt !== this.halted) { this.halted = halt; log.warn({ halt: halt ?? "cleared" }, "Brain risk state changed"); }
  }

  /** Daily report + candidate evaluation + safety guard; weekly proposal. */
  async dailyTick(): Promise<void> {
    const wib = new Date(Date.now() + 7 * 3600_000);
    const day = wib.toISOString().slice(0, 10), hour = wib.getUTCHours(), weekday = wib.getUTCDay();
    if (hour === 22 && this.lastDaily !== day) {
      this.lastDaily = day;
      const policy = this.policy.active();
      const eps = this.episodes.all();
      const m = metrics(eps, policy.knobs.costPct, this.regime.shifts());
      const auto = effectiveAutonomy(this.cfg.autonomy, { trades: m.trades, expectancy: m.expectancy, profitFactor: m.profitFactor, maxDrawdown: m.maxDrawdown });
      this.autonomyNote = `${auto.level}: ${auto.note}`;
      const ev = this.policy.evaluate(eps);
      const guard = this.policy.guard(eps);
      const text = `${formatMetrics(m, `Rapor Market Brain ${day} (policy ${policy.id}, otonomi ${this.autonomyNote})`)}\nRezim: ${regimeBrief(this.regime.current())}\nPelajaran tersimpan: ${this.lessons.all().length}${ev ? `\nKandidat ${this.policy.candidate()?.id ?? ""}: ${ev.verdict}` : ""}${guard ? `\nGuard: ${guard}` : ""}${this.halted ? `\nRISK HALT: ${this.halted}` : ""}`;
      log.info({ report: text, metrics: m }, "Brain daily report");
      await this.cfg.report(text).catch(() => undefined);
    }
    if (weekday === 0 && hour === 20 && this.lastWeekly !== day) {
      this.lastWeekly = day;
      const eps = this.episodes.all();
      const labeledReviewed = eps.filter((e) => e.reviewed && e.label).length;
      if (labeledReviewed < 60 || this.policy.candidate() || !this.brainAi()) { log.info({ labeledReviewed, candidate: this.policy.candidate()?.id }, "Brain weekly proposal skipped"); return; }
      const policy = this.policy.active();
      const m = metrics(eps, policy.knobs.costPct, this.regime.shifts());
      try {
        const proposal = await this.editor.proposePolicy({ metrics: m, knobs: policy.knobs, notes: policy.notes,
          lessons: this.lessons.all().sort((a, b) => b.support - a.support).slice(0, 25).map((l) => ({ key: l.key, text: l.solText ?? l.text, support: l.support, contradict: l.contradict })) });
        if (!proposal) { log.info("Brain weekly review: no change proposed"); return; }
        const v = this.policy.propose(proposal.knobs, proposal.notes, proposal.rationale);
        log.info({ candidate: v?.id, knobs: v?.knobs, notes: v?.notes, rationale: v?.rationale }, "Brain candidate policy proposed");
      } catch (error) { log.warn({ err: error }, "Brain weekly proposal failed"); }
    }
  }

  /** Human-readable status for /brain. */
  status(): string {
    const policy = this.policy.active();
    const m = metrics(this.episodes.all(), policy.knobs.costPct, this.regime.shifts());
    return `${formatMetrics(m, `Market Brain (policy ${policy.id})`)}\n${regimeBrief(this.regime.current())}\nPelajaran: ${this.lessons.all().length}${this.halted ? `\nRISK HALT: ${this.halted}` : ""}`;
  }
  flush(): void { this.episodes.flush(); }
}

function sessionOf(ms: number): string {
  const h = new Date(ms).getUTCHours();
  return h < 7 ? "ASIA" : h < 12 ? "LONDON" : h < 16 ? "LONDON_NY_OVERLAP" : h < 21 ? "NEW_YORK" : "ROLLOVER";
}
function fmt(v: number | undefined, u = "%"): string { return v === undefined ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(u === "bp" ? 1 : 2)}${u}`; }
