import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const backedUp = new Set<string>();

/** Crash-safe JSON write: temp file + rename, so a restart never sees half a file. */
export function atomicWrite(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), "utf8");
  renameSync(tmp, path);
}

/** One dated backup per file per process start, taken before the first write (migration safety). */
export function backupOnce(path: string): void {
  if (backedUp.has(path) || !existsSync(path)) return;
  backedUp.add(path);
  const target = `${path}.bak-${new Date().toISOString().slice(0, 10)}`;
  try { if (!existsSync(target)) { copyFileSync(path, target); log.info({ path, target }, "Brain file backed up before migration"); } }
  catch (error) { log.warn({ err: error, path }, "Brain backup failed"); }
}

/** Coalesces frequent saves (many episodes per minute) into one write every `ms`. */
export class DebouncedSaver {
  private timer?: NodeJS.Timeout;
  constructor(private readonly save: () => void, private readonly ms = 5000) {}
  schedule(): void { if (this.timer) return; this.timer = setTimeout(() => { this.timer = undefined; this.save(); }, this.ms); this.timer.unref?.(); }
  flush(): void { if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } this.save(); }
}

/**
 * Raw archive: every fetched article is appended, untouched, to a daily JSONL file
 * before any processing, so any decision can be replayed later against exactly
 * what the bot saw. Files older than `keepDays` are removed.
 */
export class RawArchive {
  private lastPrune = 0;
  constructor(private readonly dir: string, private readonly keepDays = 45) {
    try { mkdirSync(dir, { recursive: true }); } catch (error) { log.warn({ err: error, dir }, "Raw archive dir failed"); }
  }
  append(provider: string, item: unknown, now = new Date()): void {
    try {
      appendFileSync(join(this.dir, `${now.toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ fetchedAt: now.toISOString(), provider, item }) + "\n", "utf8");
      if (Date.now() - this.lastPrune > 6 * 3600_000) this.prune();
    } catch (error) { log.warn({ err: error }, "Raw archive append failed"); }
  }
  private prune(): void {
    this.lastPrune = Date.now();
    const cutoff = new Date(Date.now() - this.keepDays * 86400_000).toISOString().slice(0, 10);
    for (const f of readdirSync(this.dir)) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) < cutoff) rmSync(join(this.dir, f));
  }
}
