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
import { aggregate, battle, evaluateLinkage, fireRules, macroBars, macroBrief, MacroLedger, resolveFire, ruleContext, statsFrom, UNAVAILABLE_RULES, type MacroSnapshot } from "./brain-macro.js";
import { CalendarHistory, historyLine } from "./brain-calendar.js";
import { updateOfficial } from "./brain-macro.js";
import { stateAt } from "./brain-market.js";
import type { CalendarEvent } from "./economic-calendar.js";
import { currencyOf, huntQuery } from "./economic-calendar.js";
import { abnormalMove, followUpQuery, huntKeys, type NewsHunter } from "./brain-hunter.js";
import { matchPlaybook, playbookPack, priorityOf } from "./brain-events.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

export type BrainConfig = {
  basePath: string; autonomy: AutonomyLevel; killSwitch: boolean; aiCallsPerDay: number;
  dailyLossPct: number; maxDrawdownPct: number; approve?: string; rollbackTo?: string;
  report: (text: string) => Promise<void>; advisory?: (text: string) => Promise<void>;
  calendar?: () => CalendarEvent[];
  hunter?: NewsHunter;
};

/**
 * Market Brain orchestrator: closed learning loop.
 * news → context (regime + experience + lessons) → Sol decision → critic → episode →
 * market reacts (marks) → outcome label → lesson → used again in the next decision;
 * plus continuous evaluation and versioned policy candidates.
 */
export class MarketBrain {
  readonly episodes: EpisodeLedger; readonly lessons: LessonBook; readonly regime: RegimeLedger; readonly policy: PolicyRegistry;
  readonly macro: MacroLedger; readonly calendar: CalendarHistory;
  private lastMacroAt = 0;
  private retrievalCache = new Map<string, { episodeIds: string[]; lessonKeys: string[] }>();
  private aiDay = ""; private aiUsed = 0;
  private lastRegimeAt = 0; private lastMarkAt = 0; private lastDaily = ""; private lastWeekly = ""; private marking = false;
  private halted?: string; private autonomyNote = "";
  constructor(private readonly store: IntelligenceStore, private readonly editor: Editor, private readonly cfg: BrainConfig) {
    this.episodes = new EpisodeLedger(`${cfg.basePath}.episodes.json`);
    this.lessons = new LessonBook(`${cfg.basePath}.lessons.json`);
    this.regime = new RegimeLedger(`${cfg.basePath}.regime.json`);
    this.policy = new PolicyRegistry(`${cfg.basePath}.policy.json`);
    this.macro = new MacroLedger(`${cfg.basePath}.macro.json`);
    this.calendar = new CalendarHistory(`${cfg.basePath}.calendar-history.json`);
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
    if (shift) {
      log.warn({ shift }, "Brain regime shift confirmed");
      const q: Record<string, string> = { DOLLAR: "dollar DXY", YIELDS: '"Treasury yields"', RATES_FED: "Fed rate", INFLATION: "inflation", GEOPOLITICS: "Iran OR Israel OR war", RISK_OFF: "stocks selloff", RISK_ON: "stocks rally", RECESSION: "recession", LIQUIDITY: "margin call selloff", ANOMALY: "gold dollar yields", TECHNICAL_FLOW: "gold price", POSITIONING: "gold positioning" };
      this.cfg.hunter?.hunt(`regime-${shift.at.slice(0, 13)}`, `gold ${q[shift.to] ?? ""}`.trim(), `rezim pindah ${shift.from}→${shift.to}`, 60, 180);
    }
  }

  /** Share of geopolitical/energy catalysts among reviewed episodes in a window. */
  private geoShare(fromMs: number, toMs: number): number {
    const eps = this.episodes.all().filter((e) => e.reviewed && Date.parse(e.at) >= fromMs && Date.parse(e.at) < toMs);
    return eps.length ? eps.filter((e) => e.catalyst === "GEOPOLITICS" || e.catalyst === "ENERGY").length / eps.length : 0;
  }
  private goldFlowNews(now: number): number {
    const ids = new Set<string>();
    for (const e of this.episodes.all()) if (e.catalyst === "GOLD_FLOWS" && e.reviewed && now - Date.parse(e.at) < 30 * 86400_000) ids.add(e.id);
    for (const r of this.store.records()) if (r.audit?.aiCalled && now - Date.parse(r.event.firstSeenAt) < 30 * 86400_000 && catalystOf(r.event.storyKey, `${r.article.title} ${r.article.summary}`) === "GOLD_FLOWS") ids.add(r.id);
    return ids.size;
  }

  /** Hourly: linkage regime (RATE vs CB/debasement), rule chain, battle tracker. */
  async macroTick(force = false): Promise<MacroSnapshot | undefined> {
    const now = Date.now();
    if (!force && now - this.lastMacroAt < 60 * 60_000) return this.macro.current();
    this.lastMacroAt = now;
    const daily = await macroBars();
    const geo7 = this.geoShare(now - 7 * 86400_000, now), geoPrev = this.geoShare(now - 14 * 86400_000, now - 7 * 86400_000);
    const flows = this.goldFlowNews(now);
    const reading = evaluateLinkage({ now, daily, goldFlowNews30d: flows, geoShare7d: geo7, geoSharePrev7d: geoPrev }, this.macro.state.threshold);
    const pre = ruleContext(now, this.macro.state.official, daily, geo7, geoPrev);
    const { state, switched } = updateOfficial(this.macro.state, reading, pre.us30y2d);
    if (switched) {
      log.warn({ switched, score: reading.score, threshold: state.threshold, falseSwitches: state.falseSwitches.length }, "Brain linkage regime switch");
      this.cfg.hunter?.hunt(`linkage-${reading.at.slice(0, 13)}`, switched.to === "CB" ? '"central bank" gold buying OR "gold reserves" OR "fiscal" "Treasury"' : '"Treasury yields" gold OR "Fed" rate expectations', `rezim linkage pindah ${switched.from}→${switched.to}`, 90, 180);
    }
    const ctx = ruleContext(now, state.official, daily, geo7, geoPrev);
    const xauNow = (await stateAt(now).catch(() => ({} as Record<string, number>))).XAU ?? ctx.xau;
    let fires = this.macro.fires().map((f) => resolveFire(f, xauNow, now));
    for (const f of fires) if (f.resolved && !this.macro.fires().find((x) => x.id === f.id)?.resolved)
      log.info({ rule: f.rule, bias: f.bias, regime: f.regime, outcomePct: f.outcomePct, correct: f.correct }, "Brain rule resolved");
    const stats = statsFrom(fires);
    const fresh = fireRules({ ...ctx, xau: xauNow }, fires, stats);
    for (const f of fresh) log.info({ rule: f.rule, bias: f.bias, confidence: f.confidence, regime: f.regime, reason: f.reason, trigger: f.trigger }, "Brain rule fired");
    fires = [...fires, ...fresh];
    const active = fires.filter((f) => !f.resolved && now - Date.parse(f.at) < f.horizonHours * 3600_000);
    const agg = aggregate(active, stats);
    const b = battle(ctx, reading, flows, ctx.xau20d, ctx.xauZ20);
    const dxy = daily.DXY ?? [];
    const snapshot: MacroSnapshot = { at: reading.at, linkage: reading, official: state.official, officialSince: state.since, threshold: state.threshold,
      live: { oil24h: ctx.oil24h, us30y: ctx.us30y, fedImplied5d: ctx.fedImplied5d, dxy24h: dxy.length > 1 ? (dxy[dxy.length - 1][1] - dxy[dxy.length - 2][1]) / dxy[dxy.length - 2][1] * 100 : undefined },
      rules: { ...agg, active }, battle: b, unavailable: [...reading.unavailable, ...UNAVAILABLE_RULES] };
    this.macro.save(state, fires, snapshot);
    log.info({ linkage: reading.regime, official: state.official, score: reading.score, confidence: reading.confidence,
      signals: reading.signals.map((s) => `${s.name}=${s.value === null ? "n/a" : typeof s.value === "number" ? +s.value.toFixed(2) : s.value}`),
      ruleBias: agg.bias, votes: agg.votes, battle: b.camps.map((c) => `${c.camp}:${c.direction}:${c.strength}`), leader: b.leader }, "Brain macro reading");
    return snapshot;
  }

  /** Records new calendar prints and measures the gold reaction to each. */
  async calendarTick(): Promise<void> {
    const events = this.cfg.calendar?.() ?? [];
    // Around each high-impact release, search for the print itself.
    const nowMs = Date.now();
    for (const e of events) {
      const t = Date.parse(e.releaseAt);
      if ((e.impact === "high" || priorityOf(e.name) === "CRITICAL") && nowMs >= t - 2 * 60_000 && nowMs <= t + 20 * 60_000) { const h = huntQuery(e); this.cfg.hunter?.hunt(`cal-${e.id}`, h.query, `rilis ${e.name}`, h.minutes, h.everySeconds); }
    }
    const added = this.calendar.observe(events, this.macro.state.official);
    for (const r of added) log.info({ event: r.name, actual: r.actual, consensus: r.consensus, surprise: r.surprise, surpriseZ: r.surpriseZ, linkage: r.linkage, expectedBias: r.expectedBias }, "Brain calendar print recorded");
    for (const r of await this.calendar.resolve()) log.info({ event: r.name, surprise: r.surprise, xau5: r.xau5, xau15: r.xau15, xau60: r.xau60, dxy5: r.dxy5, us10y5bp: r.us10y5bp, expectedBias: r.expectedBias }, "Brain calendar reaction measured");
  }
  /** "Last times this print beat/missed, gold did X" for briefings and Sol. */
  calendarInsight(name: string): string { return historyLine(this.calendar.all(), { name }); }
  /** Everything Sol needs to explain a scheduled release: owner chain, regime, history, and the market move since the print. */
  async calendarContext(e: CalendarEvent, stage: "WARNING" | "ACTUAL"): Promise<string> {
    const m = this.macro.current();
    const pack = playbookPack(e.name, { linkage: m?.official ?? "MIXED", oil24h: m?.live?.oil24h, us30y: m?.live?.us30y, dxy24h: m?.live?.dxy24h });
    const lines = [pack, macroBrief(m), this.calendarInsight(e.name)];
    if (stage === "ACTUAL") {
      const t = Date.parse(e.releaseAt);
      const [pre, now] = (await Promise.all([stateAt(t - 2 * 60_000).catch(() => ({})), stateAt(Date.now()).catch(() => ({}))])) as Array<Record<string, number | undefined>>;
      const mv = (a: string) => pre[a] !== undefined && now[a] !== undefined ? (a === "US10Y" || a === "US2Y" ? `${((now[a]! - pre[a]!) * 100).toFixed(1)}bp` : a === "VIX" ? `${(now[a]! - pre[a]!).toFixed(2)} poin` : `${(((now[a]! - pre[a]!) / pre[a]!) * 100).toFixed(2)}%`) : "n/a";
      const curve = ["US2Y", "US10Y"].every((a) => pre[a] !== undefined && now[a] !== undefined) ? `${(((now.US10Y! - now.US2Y!) - (pre.US10Y! - pre.US2Y!)) * 100).toFixed(1)}bp` : "n/a";
      lines.push(`REAKSI SEJAK RILIS (${Math.round((Date.now() - t) / 60_000)} menit): XAU ${mv("XAU")}, DXY ${mv("DXY")}, US2Y ${mv("US2Y")}, US10Y ${mv("US10Y")}, kurva 2s10s ${curve}, WTI ${mv("WTI")}, S&P500 ${mv("SPX")}, VIX ${mv("VIX")}`);
    }
    return lines.filter(Boolean).join("\n");
  }
  macroBrief(): string { return macroBrief(this.macro.current()); }
  /** Official linkage regime right now (RATE / CB / MIXED). */
  linkage(): "RATE" | "CB" | "MIXED" { return this.macro.current()?.official ?? "MIXED"; }

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
    const m = this.macro.current();
    const playbook = playbookPack(`${article.title} ${article.summary.slice(0, 600)}`, { linkage: m?.official ?? "MIXED", oil24h: m?.live?.oil24h, us30y: m?.live?.us30y, dxy24h: m?.live?.dxy24h });
    if (playbook) log.info({ event: event.key.slice(0, 10), codes: matchPlaybook(`${article.title} ${article.summary.slice(0, 600)}`).map((p) => p.code) }, "Brain playbook matched");
    return [regimeBrief(current), macroBrief(this.macro.current()), playbook, experiencePack(found, lessons, this.lessons, now), notes ? `ACTIVE_POLICY_NOTES (${this.policy.active().id}):\n${notes}` : ""].filter(Boolean).join("\n\n");
  }

  /** Independent second check before publishing, with the real pre-move numbers. */
  async critic(article: NewsArticle, event: EventAssessment, primary: EditorialDecision | undefined, reason: string, allowed: boolean): Promise<CriticResult> {
    if (!allowed) return { verdict: "SKIPPED", reasons: ["anggaran AI habis"], pricedIn: false, preMoved: false, whipsawRisk: "MEDIUM", sourceIssue: false, crossMarketConflict: false };
    const t0 = Date.now();
    const ctx = await marketContextAt(t0).catch(() => undefined);
    const context = [regimeBrief(this.regime.current()), macroBrief(this.macro.current()),
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
      retrieval: this.retrievalCache.get(result.id), marks: {},
      macro: this.macro.current() ? { linkage: this.macro.current()!.official, score: this.macro.current()!.linkage.score, ruleBias: this.macro.current()!.rules.bias, leader: this.macro.current()!.battle.leader } : undefined
    };
    this.episodes.upsert(e);
    if (reviewed) log.info({ episode: e.id.slice(0, 10), stage: e.stage, catalyst: e.catalyst, regime: e.regime?.primary, tier: e.tier,
      decision: decision ? `${decision.direction}/${decision.confidence}/${decision.action}` : "none", finalAction: e.finalAction, guardrails: e.guardrails,
      linkage: e.macro?.linkage, critic: critic?.verdict, preXau15: e.pre.m15.XAU, vol60: e.vol60, retrieved: e.retrieval?.episodeIds.length ?? 0, lessons: e.retrieval?.lessonKeys.length ?? 0,
      health: health?.note, policy: policy.id }, "Brain episode created");
    // Shadow test of a candidate policy's prompt notes on published news (never affects the alert).
    const cand = this.policy.candidate();
    if (cand && cand.notes && cand.notes !== policy.notes && published && this.brainAi()) {
      void this.editor.candidateDecision(result.article, cand.notes).then((c) => {
        const cur = this.episodes.get(e.id); if (!cur) return;
        this.episodes.upsert({ ...cur, candidate: { policyVersion: cand.id, ...c } });
      }).catch((error) => log.warn({ err: error }, "Brain candidate shadow failed"));
    }
    // Follow the developing story of every published alert for two hours.
    if (published) { const q = followUpQuery(e.title); if (q) this.cfg.hunter?.hunt(`follow-${e.id.slice(0, 12)}`, q, `lanjutan: ${e.title.slice(0, 60)}`, 120, 300); }
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
      // Gold moved hard and nothing we sent explains it: go find out why.
      if (this.cfg.hunter) {
        const moved = await abnormalMove(now).catch(() => undefined);
        const explained = this.store.records().some((r) => r.stage === "SENT" && r.sentAt && now - Date.parse(r.sentAt) < 30 * 60_000);
        if (moved && !explained) {
          const k = huntKeys(now).move;
          log.warn({ xau15m: moved.xau, drivers: moved.drivers }, "Brain unexplained gold move: hunting for the cause");
          this.cfg.hunter.hunt(`${k}-gold`, "gold price", `emas gerak ${moved.xau}% 15 menit tanpa alert`, 45, 60);
          for (const d of moved.drivers) this.cfg.hunter.hunt(`${k}-${d}`, `"${d}"`, `ikut gerak bareng emas (${moved.xau}%)`, 45, 90);
        }
      }
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
      const text = `${formatMetrics(m, `Rapor Market Brain ${day} (policy ${policy.id}, otonomi ${this.autonomyNote})`)}\nRezim: ${regimeBrief(this.regime.current())}\n${macroBrief(this.macro.current())}\nRule hit-rate: ${Object.entries(statsFrom(this.macro.fires())).map(([k, v]) => `${k} ${v.hits}/${v.n}`).join(" · ") || "belum ada yang selesai"}\nKalender tercatat: ${this.calendar.all().length}\nPelajaran tersimpan: ${this.lessons.all().length}${ev ? `\nKandidat ${this.policy.candidate()?.id ?? ""}: ${ev.verdict}` : ""}${guard ? `\nGuard: ${guard}` : ""}${this.halted ? `\nRISK HALT: ${this.halted}` : ""}`;
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
    return `${formatMetrics(m, `Market Brain (policy ${policy.id})`)}\n${regimeBrief(this.regime.current())}\n${macroBrief(this.macro.current())}\nPelajaran: ${this.lessons.all().length}${this.halted ? `\nRISK HALT: ${this.halted}` : ""}`;
  }
  flush(): void { this.episodes.flush(); }
}

function sessionOf(ms: number): string {
  const h = new Date(ms).getUTCHours();
  return h < 7 ? "ASIA" : h < 12 ? "LONDON" : h < 16 ? "LONDON_NY_OVERLAP" : h < 21 ? "NEW_YORK" : "ROLLOVER";
}
function fmt(v: number | undefined, u = "%"): string { return v === undefined ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(u === "bp" ? 1 : 2)}${u}`; }
