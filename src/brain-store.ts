import { copyFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
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
