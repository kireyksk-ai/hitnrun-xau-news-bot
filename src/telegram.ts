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

export type AdminUpdate = { update_id: number; message?: {
  from?: { id?: number }; chat?: { id?: number }; text?: string;
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

