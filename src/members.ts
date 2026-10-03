/**
 * FastXAUNews real-time members (owner, 2026-10-03). Visitors ask for access on the website; the admin checks the
 * Exness account in the partner area and answers /approve, /tolak or /keluarkan in the admin chat. State is a JSON file.
 */
import { readFileSync, writeFileSync } from "node:fs";

export type AccessRequest = { id: string; at: string; account: string; email: string; telegram: string; country: string; notes: string; path?: "new" | "switch" };
export type MemberStatus = "pending" | "approved" | "rejected" | "removed";
export type Member = { account: string; telegram: string; email: string; country: string; status: MemberStatus; requestedAt: string;
  decidedAt?: string; userId?: number; chatId?: number };
type State = { members: Member[]; starts: Record<string, { userId: number; chatId: number }>; lastRequestAt: string };

export class Members {
  private state: State;
  constructor(private readonly path: string) {
    try { this.state = JSON.parse(readFileSync(path, "utf8")) as State; }
    catch { this.state = { members: [], starts: {}, lastRequestAt: "" }; }
    this.state.starts ??= {}; this.state.members ??= []; this.state.lastRequestAt ??= "";
  }
  private save(): void { try { writeFileSync(this.path, JSON.stringify(this.state)); } catch { /* best effort */ } }
  get lastRequestAt(): string { return this.state.lastRequestAt; }
  all(): Member[] { return [...this.state.members]; }
  get(account: string): Member | undefined { return this.state.members.find((m) => m.account === account); }

  /** A website request; returns the member record (new or refreshed). */
  addRequest(r: AccessRequest): Member {
    if (r.at > this.state.lastRequestAt) this.state.lastRequestAt = r.at;
    const telegram = normaliseUsername(r.telegram);
    let m = this.get(r.account);
    if (!m) { m = { account: r.account, telegram, email: r.email, country: r.country, status: "pending", requestedAt: r.at }; this.state.members.push(m); }
    else if (m.status !== "approved") Object.assign(m, { telegram, email: r.email, country: r.country, status: "pending", requestedAt: r.at });
    const start = this.state.starts[telegram];
    if (start) Object.assign(m, start);
    this.save();
    return m;
  }

  /** Someone pressed Start in a private chat with the bot. */
  recordStart(username: string | undefined, userId: number, chatId: number): Member[] {
    const key = normaliseUsername(username ?? "");
    if (!key) return [];
    this.state.starts[key] = { userId, chatId };
    const linked = this.state.members.filter((m) => m.telegram === key);
    for (const m of linked) Object.assign(m, { userId, chatId });
    this.save();
    return linked;
  }

  setStatus(account: string, status: MemberStatus): Member | undefined {
    const m = this.get(account);
    if (!m) return undefined;
    m.status = status; m.decidedAt = new Date().toISOString();
    this.save();
    return m;
  }
}

export const normaliseUsername = (value: string) => value.trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "").toLowerCase();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function formatRequest(r: AccessRequest, m: Member): string {
  return [`🆕 <b>Pendaftar FastXAUNews</b>`, `Akun Exness: <code>${esc(r.account)}</code>`, r.path === "switch" ? "Jalur: 🔁 <b>PINDAH IB</b> (akun lama dari partner lain; pastikan sudah benar-benar pindah ke kode partner 1044920275187099225)" : "Jalur: 🆕 akun baru lewat link IB", `Telegram: @${esc(m.telegram)}${m.chatId ? " (sudah Start bot ✓)" : " (belum Start bot)"}`,
    `Email: ${esc(r.email)}`, r.country ? `Negara: ${esc(r.country)}` : "", r.notes ? `Catatan: ${esc(r.notes)}` : "",
    "", `Cek akun ini di Partner Area Exness, lalu balas:`, `<code>/approve ${esc(r.account)}</code> atau <code>/tolak ${esc(r.account)}</code>`].filter((l) => l !== "").join("\n");
}

export function formatMembers(list: Member[]): string {
  const approved = list.filter((m) => m.status === "approved"), pending = list.filter((m) => m.status === "pending");
  const line = (m: Member) => `<code>${esc(m.account)}</code> @${esc(m.telegram)} · ${(m.decidedAt ?? m.requestedAt).slice(0, 10)}`;
  return [`👥 <b>Member FastXAUNews</b>: ${approved.length} aktif, ${pending.length} menunggu`, "",
    approved.length ? `<b>Aktif</b> (cek volume di Partner Area; yang tidak trading 30 hari → <code>/keluarkan akun1 akun2</code>)\n${approved.map(line).join("\n")}` : "Belum ada member aktif.",
    pending.length ? `\n<b>Menunggu</b>\n${pending.map(line).join("\n")}` : ""].join("\n").slice(0, 3900);
}

/** The real-time channel post (English), Telegram HTML. */
export function formatChannelPost(kind: "alert" | "desk", marker: string, en: { headline: string; note: string; impact: string; watch: string }): string {
  const icon = kind === "desk" ? "🧭" : marker === "red" ? "🔴" : marker === "white" ? "⚪" : "🟡";
  const impact = { bullish: "↗ Bullish for gold", bearish: "↘ Bearish for gold", mixed: "↗↘ Mixed for gold", neutral: "→ Limited effect on gold" }[en.impact] ?? "";
  return [`${icon} <b>${kind === "desk" ? "DESK UPDATE — " : ""}${esc(en.headline)}</b>`, "", esc(en.note), "", impact ? `<i>${impact}</i>` : "", en.watch ? `👀 Watch: ${esc(en.watch)}` : ""]
    .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== "")).join("\n").trim();
}
