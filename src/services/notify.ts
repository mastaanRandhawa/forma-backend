import { prisma } from "../prisma.js";

type NotifType =
  | "trainer_message" | "reminder" | "milestone" | "pr"
  | "check_in" | "weekly_summary" | "feature_unlocked";

const PREF_KEY: Record<NotifType, keyof Awaited<ReturnType<typeof defaultPrefs>>> = {
  trainer_message: "trainerMessages",
  reminder: "workoutReminders",
  milestone: "milestones",
  pr: "milestones",
  check_in: "checkIns",
  weekly_summary: "weeklySummary",
  feature_unlocked: "milestones",
};

async function defaultPrefs() {
  return {
    workoutReminders: true, restTimerAlerts: true, trainerMessages: true,
    milestones: true, weeklySummary: true, checkIns: true,
  };
}

/**
 * Create a notification row if the user's preferences allow that type.
 * Transport (APNs / FCM) is a separate worker concern — this only persists.
 */
export async function notify(
  userId: string,
  type: NotifType,
  title: string,
  body: string,
  deepLink?: string,
) {
  const prefs = await prisma.notificationPreference.findUnique({ where: { userId } });
  const allowed = prefs ? (prefs as Record<string, unknown>)[PREF_KEY[type]] !== false : true;
  if (!allowed) return null;
  return prisma.notification.create({ data: { userId, type, title, body, deepLink } });
}
