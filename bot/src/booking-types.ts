export const THEORY_SERVICE_ID = "theory_group" as const;
export const TBILISI_TIMEZONE = "Asia/Tbilisi" as const;

export type GroupDateStatus = "planned" | "confirmed";
export type GroupLifecycle = "scheduled" | "cancelled" | "completed";
export type BookingSource = "telegram" | "site_form" | "site_chat" | "legacy";
export type BookingStatus = "pending" | "confirmed" | "declined" | "cancelled" | "completed";
export type Availability = "open" | "full" | "closed";
export type OutboxRecipientRole = "student" | "staff" | "manual";
export type OutboxState =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "manual_contact"
  | "resolved"
  | "superseded";

export interface Group {
  id: string;
  serviceId: string;
  sequence: number;
  startDate: string;
  startTime: string;
  timezone: typeof TBILISI_TIMEZONE;
  startsAtUtc: string;
  dateStatus: GroupDateStatus;
  enrollmentOpen: boolean;
  lifecycle: GroupLifecycle;
  capacity: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  completedAt: string | null;
}

export interface PublicGroup {
  id: string;
  revision: number;
  startDate: string;
  startTime: string;
  dateStatus: GroupDateStatus;
  enrollmentOpen: boolean;
  availability: Availability;
}

export interface PublicGroupsSnapshot {
  scheduleRevision: number;
  fetchedAt: string;
  timezone: typeof TBILISI_TIMEZONE;
  groups: PublicGroup[];
}

export interface GroupListQuery {
  serviceId?: string;
  includeHistory?: boolean;
  limit?: number;
  cursor?: string;
  now?: Date;
}

export interface AdminGroup extends Group {
  pendingCount: number;
  confirmedCount: number;
}

export interface GroupListResult {
  scheduleRevision: number;
  groups: AdminGroup[];
  nextCursor: string | null;
}

interface ScheduleCommandBase {
  expectedRevision: number;
  serviceId?: string;
}

export interface CreateScheduleCommand extends ScheduleCommandBase {
  action: "create";
  firstDate: string;
  startTime: string;
  count: number;
  capacity: number;
}

export interface AppendScheduleCommand extends ScheduleCommandBase {
  action: "append";
  lastGroupId: string;
}

export interface MoveScheduleCommand extends ScheduleCommandBase {
  action: "move";
  groupId: string;
  newDate: string;
  newTime: string;
  scope: "one" | "following_planned";
  ackConfirmedMove: boolean;
}

export interface CancelScheduleCommand extends ScheduleCommandBase {
  action: "cancel";
  groupId: string;
}

export type ScheduleCommand =
  | CreateScheduleCommand
  | AppendScheduleCommand
  | MoveScheduleCommand
  | CancelScheduleCommand;

export interface ScheduleChange {
  id: string | null;
  sequence: number;
  oldDate: string | null;
  newDate: string | null;
  oldTime: string | null;
  newTime: string | null;
  oldDateStatus: GroupDateStatus | null;
  newDateStatus: GroupDateStatus | null;
  lifecycle: GroupLifecycle;
}

export interface SchedulePreview {
  expectedRevision: number;
  normalizedCommand: ScheduleCommand;
  changes: ScheduleChange[];
  affectedBookings: number;
  notificationCount: number;
  warnings: string[];
}

export interface ScheduleCommitResult {
  scheduleRevision: number;
  changes: ScheduleChange[];
  affectedBookings: number;
  notificationCount: number;
}

export interface GroupPatch {
  expectedRevision: number;
  expectedScheduleRevision: number;
  dateStatus?: GroupDateStatus;
  enrollmentOpen?: boolean;
  capacity?: number;
}

export interface CommandFence {
  chatId: number;
  leaseToken: string;
  leaseRevision: number;
}

export interface ConversationFence {
  id: string;
  revision: number;
}

export interface CreateBookingInput {
  groupId: string;
  groupRevision: number;
  name: string;
  phone: string;
  consentVersion: string;
  consentAt?: string;
  source: Exclude<BookingSource, "legacy">;
  studentChatId?: number;
  conversation?: ConversationFence;
  fence?: CommandFence;
}

export interface BookingReceipt {
  id: string;
  reference: string;
  status: "pending";
  groupId: string;
  revision: number;
  notificationState: "pending";
  contactMethod: "telegram" | "phone";
}

export interface Booking {
  id: string;
  publicReference: string;
  groupId: string | null;
  name: string | null;
  phone: string | null;
  studentChatId: number | null;
  source: BookingSource;
  status: BookingStatus;
  revision: number;
  consentVersion: string;
  consentAt: string;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
  piiErasedAt: string | null;
}

export interface BookingActionInput {
  action: "confirm" | "decline" | "cancel" | "complete" | "transfer";
  expectedRevision: number;
  groupRevision: number;
  targetGroupId?: string;
  targetGroupRevision?: number;
}

export interface BookingActionResult {
  id: string;
  status: BookingStatus;
  revision: number;
  groupId: string | null;
  notificationState: "pending";
}

export interface BookingListQuery {
  groupId?: string;
  status?: BookingStatus;
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface BookingListItem extends Booking {
  possibleDuplicate: boolean;
  groupStartDate: string | null;
  groupStartTime: string | null;
  groupRevision: number | null;
}

export interface BookingListResult {
  bookings: BookingListItem[];
  nextCursor: string | null;
}

export interface AuditInsertInput {
  id?: string;
  entityType: "group" | "booking" | "schedule" | "notification";
  entityId: string;
  operationId: string;
  actorId: string;
  action: string;
  oldState?: Record<string, unknown> | null;
  newState?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface OutboxInsertInput {
  id?: string;
  eventId: string;
  bookingId?: string | null;
  groupId?: string | null;
  conversationId?: string | null;
  eventType: string;
  safeTemplateId: string;
  conversationRevision?: number | null;
  bookingRevision?: number | null;
  groupRevision?: number | null;
  recipientKey: string;
  recipientRole: OutboxRecipientRole;
  state?: OutboxState;
  retryAt?: string | null;
  createdAt?: string;
}

export interface CommandOutcome<T> {
  replayed: boolean;
  result: T;
}
