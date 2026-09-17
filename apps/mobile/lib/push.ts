// ──────────────────────────────────────────────
// Push notifications (Phase 9.3) — FCM via expo-notifications + deep links.
//
// Server side already exists (communication-service §5.4):
//   • POST /communication/devices registers the FCM token against the
//     logged-in user (upsert by token; newest account on the phone wins)
//   • the dispatcher sends `data.deepLink` with every push
//
// Client side (this module):
//   1. registerPushToken() — permissions → FCM token → POST /devices
//   2. App.tsx calls it after login (see the wiring there)
//   3. notification taps surface a deepLink (`erp://fees`, `erp://attendance`,
//      `erp://results`, …) which the navigation layer maps to a screen
//   4. Android needs a channel before any notification renders
//
// Tokens rotate on app data-clear/reinstall; re-registration is idempotent
// (upsert keyed by token) so calling this on every login is correct.
// ──────────────────────────────────────────────
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { communicationApi } from './api';

/** What the app shows while a notification arrives in the foreground. */
export function configureForegroundPresentation(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/** Android requires a named channel; created once, reused forever. */
async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('default', {
    name: 'School updates',
    description: 'Attendance, fees, results and announcements',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
    enableVibrate: true,
  });
}

/** Ask, fetch the FCM token, register it against the logged-in account.
 *  Silent no-op on unsupported devices (simulators without FCM). */
export async function registerPushToken(): Promise<string | null> {
  try {
    if (!Device.isDevice) return null; // FCM push needs a real device
    ensureAndroidChannel();

    // (Avoid the NotificationPermissionsStatus type surface — it extends a
    // type from 'expo' that resolves inconsistently under this tsconfig.
    // `granted` is the stable field on every SDK version.)
    let granted = ((await Notifications.getPermissionsAsync()) as { granted?: boolean }).granted === true;
    if (!granted) {
      granted = ((await Notifications.requestPermissionsAsync()) as { granted?: boolean }).granted === true;
    }
    if (!granted) return null;

    // DevicePushToken = { type: 'ios'|'android', data: string } on native.
    const tokenRes = (await Notifications.getDevicePushTokenAsync()) as { data?: unknown };
    const fcmToken = typeof tokenRes?.data === 'string' ? tokenRes.data : null;
    if (!fcmToken || fcmToken.length < 16) return null;

    const platform = Platform.OS === 'android' ? 'ANDROID' : 'IOS';
    const label = Device.modelName ?? undefined;
    await communicationApi.registerDevice({ token: fcmToken, platform, label });
    return fcmToken;
  } catch {
    // Push is an enhancement: a failing registration must never block login.
    return null;
  }
}

/** Hook the tap handler; returns the deepLink string if the notification
 *  carried one. `erp://fees`, `erp://attendance`, `erp://results` … */
export function extractDeepLink(response: Notifications.NotificationResponse): string | null {
  const data = response.notification.request.content.data as { deepLink?: string } | undefined;
  const link = data?.deepLink;
  return typeof link === 'string' && link.length > 0 ? link : null;
}

/** Map a server deepLink to a navigation route + params. One place, so the
 *  server's link vocabulary and the app's routes stay in sync. */
export function routeForDeepLink(link: string): { route: string; params?: Record<string, string> } | null {
  const rest = link.replace(/^erp:\/\//, '');
  switch (rest) {
    case 'fees':
    case 'fees/due':
      return { route: 'Fees' };
    case 'attendance':
    case 'attendance/absent':
      return { route: 'Attendance' };
    case 'results':
    case 'results/published':
      return { route: 'Results' };
    case 'announcements':
      return { route: 'More' };
    case 'timetable':
      return { route: 'Timetable' };
    default:
      return null;
  }
}
