import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), email: text('email').notNull().unique(), timezone: text('timezone').notNull().default('UTC'),
  locale: text('locale').notNull().default('en-GB'), settingsJson: text('settings_json').notNull().default('{}'),
  firstName: text('first_name').notNull().default(''), lastName: text('last_name').notNull().default(''),
  role: text('role').notNull().default('user'), active: integer('active').notNull().default(1),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull()
});
export const meetings = sqliteTable('meetings', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id), title: text('title').notNull(), date: text('date').notNull(),
  start: text('start').notNull(), end: text('end').notNull(), client: text('client').notNull().default(''), contacts: text('contacts').notNull().default(''),
  type: text('type').notNull(), location: text('location').notNull().default(''), notes: text('notes').notNull().default(''), outcome: text('outcome').notNull().default(''),
  status: text('status').notNull(), followUpDate: text('follow_up_date'), reminderLeadJson: text('reminder_lead_json'), createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(), deletedAt: text('deleted_at'), version: integer('version').notNull().default(1)
}, (table) => [index('meetings_user_date').on(table.userId, table.date, table.start)]);
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id), title: text('title').notNull(), dueDate: text('due_date').notNull(),
  dueTime: text('due_time'), priority: text('priority').notNull(), status: text('status').notNull(), category: text('category').notNull(), client: text('client').notNull().default(''),
  meetingId: text('meeting_id').references(() => meetings.id), notes: text('notes').notNull().default(''), completedAt: text('completed_at'), reminderLeadJson: text('reminder_lead_json'),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(), deletedAt: text('deleted_at'), version: integer('version').notNull().default(1)
}, (table) => [index('tasks_user_due').on(table.userId, table.dueDate, table.dueTime)]);
export const reminders = sqliteTable('reminders', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id), targetType: text('target_type').notNull(), targetId: text('target_id').notNull(),
  fireAt: text('fire_at').notNull(), channel: text('channel').notNull(), lead: integer('lead').notNull().default(0), state: text('state').notNull(),
  attempts: integer('attempts').notNull().default(0), lastError: text('last_error'), sentAt: text('sent_at'), createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(), dedupeKey: text('dedupe_key').notNull()
}, (table) => [index('reminders_due').on(table.state, table.fireAt), uniqueIndex('reminders_dedupe').on(table.dedupeKey)]);
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id), tokenHash: text('token_hash').notNull().unique(),
  device: text('device').notNull(), ipHash: text('ip_hash').notNull(), createdAt: text('created_at').notNull(), lastSeenAt: text('last_seen_at').notNull(),
  expiresAt: text('expires_at').notNull(), revokedAt: text('revoked_at')
});
