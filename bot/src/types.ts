export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_PATH_SECRET: string;   // секретный сегмент URL вебхука
  WEBHOOK_HEADER_SECRET: string; // значение X-Telegram-Bot-Api-Secret-Token
  ADMIN_CHAT_ID: string; // ID закрытой группы админов, строкой из vars
  ADMIN_IDS: string;     // Telegram ID админов через запятую
  // Новый контур включается только явным значением true. Так миграция и деплой
  // кода сами по себе не переключают существующие заявки на другой writer.
  BOOKING_ENABLED?: string;
  BOOKING_SECRET?: string;
  BOOKING_ALLOWED_ORIGINS?: string;
  TURNSTILE_SECRET?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_ALLOWED_EMAILS?: string;
  ADMIN_ORIGIN?: string;
  ASSETS?: Fetcher;
  // Тестовый шов остается частью Env: inbox и outbox используют тот же клиент,
  // поэтому failure-injection не должен подменять глобальный fetch.
  __fetch?: typeof fetch;
}

export type LeadStatus = "new" | "in_progress" | "contacted" | "closed";

export interface Lead {
  id: number;
  submission_id: string;
  name: string;
  phone: string;
  question: string | null;
  status: LeadStatus;
  assigned_to_id: number | null;
  assigned_to_name: string | null;
  student_chat_id: number;
  telegram_message_id: number | null;
  delivery_status: "pending" | "delivered";
  created_at: string;
  updated_at: string;
}
