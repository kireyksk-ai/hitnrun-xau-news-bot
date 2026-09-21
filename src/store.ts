import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { NewsArticle } from "./types.js";

export class Store {
  private entries: Record<string, { seenAt: string; posted: boolean; action?: string; changeType?: string }>;
  private readonly path: string;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.path = `${path}.json`;
    this.entries = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {};
  }
  fingerprint(article: NewsArticle): string {
    const normalized = `${article.title} ${article.summary}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return createHash("sha256").update(normalized).digest("hex");
  }
  has(article: NewsArticle): boolean {
    return Boolean(this.entries[this.fingerprint(article)]);
  }
  hasEvent(eventKey: string): boolean {
    return Boolean(this.entries[this.eventFingerprint(eventKey)]);
  }
  remember(article: NewsArticle, posted: boolean): void {
    this.entries[this.fingerprint(article)] = { seenAt: new Date().toISOString(), posted };
    this.persist();
  }
  rememberEvent(eventKey: string, posted: boolean): void {
    this.entries[this.eventFingerprint(eventKey)] = { seenAt: new Date().toISOString(), posted };
    this.persist();
  }
  getStory(storyKey: string): { action?: string; changeType?: string; seenAt: string } | undefined {
    return this.entries[this.storyFingerprint(storyKey)];
  }
  rememberStory(storyKey: string, action: string, changeType: string): void {
    this.entries[this.storyFingerprint(storyKey)] = { seenAt: new Date().toISOString(), posted: true, action, changeType };
    this.persist();
  }
  private eventFingerprint(eventKey: string): string {
    return `event:${createHash("sha256").update(eventKey).digest("hex")}`;
  }
  private storyFingerprint(storyKey: string): string {
    return `story:${createHash("sha256").update(storyKey).digest("hex")}`;
  }
  purge(days = 14): void {
    const cutoff = Date.now() - days * 86400000;
    for (const [fingerprint, entry] of Object.entries(this.entries)) {
      if (new Date(entry.seenAt).getTime() < cutoff) delete this.entries[fingerprint];
    }
    this.persist();
  }
  private persist(): void { writeFileSync(this.path, JSON.stringify(this.entries), "utf8"); }
}
