import { z } from 'zod';

export const meetingTypes = ['Call', 'Video', 'In-person', 'Lunch', 'Conference'] as const;
export const meetingStatuses = ['Scheduled', 'Completed', 'Cancelled', 'Rescheduled'] as const;
export const taskPriorities = ['High', 'Medium', 'Low'] as const;
export const taskStatuses = ['To Do', 'In Progress', 'Done'] as const;
export const taskCategories = ['Prospecting', 'Proposal', 'Follow-up', 'Admin', 'Other'] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const recordMeta = {
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
  version: z.number().int().positive()
};

const meetingBaseSchema = z.object({
  ...recordMeta,
  title: z.string().trim().min(1).max(200),
  date: isoDate,
  start: clockTime,
  end: clockTime,
  client: z.string().max(200).default(''),
  contacts: z.string().max(400).default(''),
  type: z.enum(meetingTypes),
  location: z.string().max(500).default(''),
  notes: z.string().max(8000).default(''),
  outcome: z.string().max(8000).default(''),
  status: z.enum(meetingStatuses),
  followUpDate: isoDate.nullable().default(null),
  reminderLeadMinutes: z.array(z.number().int().min(0).max(40320)).nullable().optional()
});
export const meetingSchema = meetingBaseSchema.refine((meeting) => meeting.end > meeting.start, { message: 'End must be after start', path: ['end'] });

const taskBaseSchema = z.object({
  ...recordMeta,
  title: z.string().trim().min(1).max(200),
  dueDate: isoDate,
  dueTime: clockTime.nullable().default(null),
  priority: z.enum(taskPriorities),
  status: z.enum(taskStatuses),
  category: z.enum(taskCategories),
  client: z.string().max(200).default(''),
  meetingId: z.string().uuid().nullable().default(null),
  notes: z.string().max(8000).default(''),
  completedAt: z.string().datetime().nullable().default(null),
  reminderLeadMinutes: z.array(z.number().int().min(0).max(40320)).nullable().optional()
});
export const taskSchema = taskBaseSchema;

export const meetingInputSchema = meetingBaseSchema.omit({ id: true, createdAt: true, updatedAt: true, deletedAt: true, version: true });
export const taskInputSchema = taskBaseSchema.omit({ id: true, createdAt: true, updatedAt: true, deletedAt: true, version: true });

export const reminderPrefsSchema = z.object({
  taskLeadMinutes: z.array(z.number().int().min(1).max(40320)).default([1440, 60]),
  meetingLeadMinutes: z.array(z.number().int().min(1).max(40320)).default([60, 15]),
  followUpEnabled: z.boolean().default(true),
  overdueEnabled: z.boolean().default(true),
  digestEnabled: z.boolean().default(false),
  digestTime: clockTime.default('08:00'),
  quietStart: clockTime.nullable().default(null),
  quietEnd: clockTime.nullable().default(null),
  emailEnabled: z.boolean().default(true),
  pushEnabled: z.boolean().default(true)
});

export const loginRequestSchema = z.object({ email: z.string().email().max(254) });
export const loginVerifySchema = z.object({ token: z.string().min(24).max(256) });
export const paginationSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) });
export const importSchema = z.object({ mode: z.enum(['merge', 'replace']), data: z.object({ meetings: z.array(z.unknown()).default([]), tasks: z.array(z.unknown()).default([]) }) });

export type Meeting = z.infer<typeof meetingSchema>;
export type MeetingInput = z.infer<typeof meetingInputSchema>;
export type Task = z.infer<typeof taskSchema>;
export type TaskInput = z.infer<typeof taskInputSchema>;
export type ReminderPrefs = z.infer<typeof reminderPrefsSchema>;
export type Page<T> = { items: T[]; total: number; limit: number; offset: number };
