export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_CHAT_ID: string; // ID закрытой группы админов, строкой из vars
  ADMIN_IDS: string;     // Telegram ID админов через запятую
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
