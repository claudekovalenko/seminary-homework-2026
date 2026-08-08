// Reminders. There is no server behind this app, so notifications are raised
// while the app is running (open, or woken by Periodic Background Sync where
// the browser supports it). Everything is deduplicated so a reminder fires once.

import { settings, hasFired, markFired, updateSettings } from './store.js';
import { deadlines, formatMinutes, relativeDay, startOfToday, toISO } from './schedule.js';

export const supported = 'Notification' in window;

export const permission = () => (supported ? Notification.permission : 'unsupported');

export async function requestPermission() {
  if (!supported) return 'unsupported';
  const result = await Notification.requestPermission();
  updateSettings({ notificationsEnabled: result === 'granted' });
  return result;
}

async function show(title, body, tag) {
  if (!supported || Notification.permission !== 'granted') return false;
  const options = {
    body,
    tag,
    icon: './icons/icon-192.png',
    badge: './icons/badge.png',
    renotify: false,
    data: { url: './' }
  };
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg) {
      await reg.showNotification(title, options);
      return true;
    }
  } catch {
    /* fall through to the page-level API */
  }
  try {
    new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}

// Milestones counted in days before the deadline.
function bucketsFor(leadDays) {
  return [...new Set([leadDays, 3, 1, 0])].filter((n) => n <= leadDays && n >= 0).sort((a, b) => b - a);
}

/**
 * Fire any reminder that has come due since the last time the app ran.
 * Returns the notifications that were raised.
 */
export async function checkReminders(tasks) {
  const s = settings();
  if (!s.notificationsEnabled || permission() !== 'granted') return [];

  const fired = [];
  const groups = deadlines(tasks, { withinDays: Math.max(s.leadDays, 7) });

  for (const g of groups) {
    const applicable = bucketsFor(s.leadDays).filter((b) => g.daysUntil <= b);
    if (!applicable.length) continue;

    // Most urgent milestone wins; any looser ones we slept through are just
    // marked as seen so they do not arrive late and out of order.
    const urgent = applicable[applicable.length - 1];
    const urgentKey = `${g.key}|${urgent}`;
    const alreadySeen = hasFired(urgentKey);
    applicable.forEach((b) => markFired(`${g.key}|${b}`, new Date().toISOString()));
    if (alreadySeen) continue;

    const minutes = g.tasks.reduce((sum, t) => sum + t.remaining, 0);
    const readings = g.tasks.filter((t) => t.kind !== 'assignment');
    const assignments = g.tasks.filter((t) => t.kind === 'assignment');
    const parts = [];
    if (readings.length) parts.push(`${readings.length} readings (${formatMinutes(minutes)})`);
    if (assignments.length) parts.push(assignments.map((a) => a.title).join(', '));

    const ok = await show(`${g.courseName} — due ${relativeDay(g.date)}`, `${g.topic}\n${parts.join(' · ')}`, g.key);
    if (ok) fired.push({ group: g, bucket: urgent });
  }

  return fired;
}

/** One nudge a day, after your chosen hour, with today's reading target. */
export async function dailyNudge(todayPlan) {
  const s = settings();
  if (!s.notificationsEnabled || permission() !== 'granted') return false;
  if (new Date().getHours() < s.reminderHour) return false;

  const key = `daily|${toISO(startOfToday())}`;
  if (hasFired(key)) return false;
  if (!todayPlan || !todayPlan.minutes) return false;

  markFired(key, new Date().toISOString());
  const titles = todayPlan.items.slice(0, 3).map((i) => i.title);
  const more = todayPlan.items.length - titles.length;
  return show(
    `Today: ${formatMinutes(todayPlan.minutes)} of reading`,
    titles.join(' · ') + (more > 0 ? ` · +${more} more` : ''),
    key
  );
}

/** Ask the browser to wake the app up periodically. Chrome/Android only. */
export async function registerBackgroundChecks() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (!reg || !('periodicSync' in reg)) return false;
    const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (status.state !== 'granted') return false;
    await reg.periodicSync.register('check-deadlines', { minInterval: 12 * 60 * 60 * 1000 });
    return true;
  } catch {
    return false;
  }
}

export async function testNotification() {
  return show('Reminders are on', 'This is what a deadline reminder will look like.', 'test');
}
