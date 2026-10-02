import type { IntelligenceStore } from "./intelligence-store.js";
export type TelegramDestination = { chatId: string; messageThreadId?: number };

export async function sendTelegramMessage(token: string, destination: TelegramDestination, text: string): Promise<number> {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: destination.chatId, message_thread_id: destination.messageThreadId, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
  if (!response.ok) throw new Error(`Telegram send failed: ${response.status} ${await response.text()}`);
  const result = await response.json() as { result?: { message_id?: number } };
  if (!result.result?.message_id) throw new Error("Telegram response had no message id");
  return result.result.message_id;
}

/** Send existing public destinations as one health-accounted batch; no extra messages are generated. */
export async function deliverTelegramMessage(token:string,destinations:TelegramDestination[],text:string,store:IntelligenceStore,sender:typeof sendTelegramMessage=sendTelegramMessage):Promise<{accepted:Record<string,number>;failures:Array<{chatId:string;error:string}>}>{const accepted:Record<string,number>={},failures:Array<{chatId:string;error:string}>=[],outcomes=[];for(const destination of destinations){try{accepted[destination.chatId]=await sender(token,destination,text);outcomes.push({destination:destination.chatId,success:true});}catch(error){const message=error instanceof Error?error.message:"unknown Telegram send failure";failures.push({chatId:destination.chatId,error:message});outcomes.push({destination:destination.chatId,success:false,error:message});}}store.recordTelegramDeliveryAttempt(outcomes);return{accepted,failures};}

export type AdminUpdate = { update_id: number; message?: {
  from?: { id?: number; username?: string }; chat?: { id?: number; type?: string }; text?: string;
  reply_to_message?: { message_id?: number };
} };
export async function fetchAdminUpdates(token: string, offset: number): Promise<AdminUpdate[]> {
  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&limit=100&timeout=0`);
  if (!response.ok) throw new Error(`Telegram admin polling failed: ${response.status}`);
  const data = await response.json() as { result?: AdminUpdate[] };
  return data.result ?? [];
}

export async function discoverTelegramDestination(token: string): Promise<TelegramDestination> {
  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=100`);
  if (!response.ok) throw new Error(`Telegram discovery failed: ${response.status} ${await response.text()}`);
  const body = await response.json() as { result?: Array<{ message?: { chat?: { id?: number; type?: string }; message_thread_id?: number } }> };
  const update = [...(body.result ?? [])].reverse().find((item) =>
    item.message?.chat?.type === "group" || item.message?.chat?.type === "supergroup"
  );
  const chatId = update?.message?.chat?.id;
  if (!chatId) throw new Error("No Telegram group found. Send /start@HitnRunXAUAlert_bot in the target group, then restart the bot.");
  return { chatId: String(chatId), messageThreadId: update?.message?.message_thread_id };
}


async function callTelegram<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({})) as { ok?: boolean; result?: T; description?: string };
  if (!response.ok || !data.ok) throw new Error(`Telegram ${method} failed: ${response.status} ${data.description ?? ""}`);
  return data.result as T;
}
/** Single-use invite link to a private channel (expires after 7 days). */
export async function createSingleUseInvite(token: string, chatId: string, name: string): Promise<string> {
  const r = await callTelegram<{ invite_link: string }>(token, "createChatInviteLink", { chat_id: chatId, name: name.slice(0, 32), member_limit: 1, expire_date: Math.floor(Date.now() / 1000) + 7 * 86400 });
  return r.invite_link;
}
/** Removes a member from a channel without a permanent ban (ban + unban). */
export async function removeFromChat(token: string, chatId: string, userId: number): Promise<void> {
  await callTelegram(token, "banChatMember", { chat_id: chatId, user_id: userId });
  await callTelegram(token, "unbanChatMember", { chat_id: chatId, user_id: userId, only_if_banned: true });
}
export async function botUsername(token: string): Promise<string> {
  return (await callTelegram<{ username: string }>(token, "getMe", {})).username;
}
