// Settings › notifications (#1308 slice 5 item 2).
//
// Its OWN section rather than three more rows under general, following the
// `SettingsAgentProfilesSection` precedent: the lane has a permission state, a
// grant affordance, and three triggers, which is a topic, not a setting.
//
// Device-local by design. Unlike general's `Notifications` row (which writes
// `PUT /config` to arm the legacy per-session push lane), everything here is
// localStorage: a notification preference belongs to THIS browser and the OS
// permission grant it holds, and syncing it would be wrong as well as more
// expensive.
import { useEffect, useState } from 'react';
import SettingRow from './SettingRow.js';
import TuiButton from '../TuiButton.js';
import TuiCheckbox from '../TuiCheckbox.js';
import {
  notifyPermissionState,
  type NotifyPermissionState,
} from '../../lib/notify/os-notification.js';
import { notifyOsNotifier } from '../../lib/notify/runtime.js';
import { useNotifySettingsStore } from '../../lib/stores/notify-settings.js';

/** Search terms that keep this section undimmed (mirrors `SECTION_KEYWORDS`). */
export const NOTIFICATIONS_SECTION_KEYWORDS = [
  'notifications',
  'browser notifications',
  'desktop notifications',
  'permission',
  'mentions',
  'direct message',
  'dm',
  'turn complete',
  'badge',
  'favicon',
];

function matchesSearch(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    'notifications'.includes(q) ||
    NOTIFICATIONS_SECTION_KEYWORDS.some((term) => term.includes(q))
  );
}

const PERMISSION_DESCRIPTION: Record<NotifyPermissionState, string> = {
  granted: 'this browser may show relay notifications',
  denied: 'blocked by the browser — re-allow in site settings',
  default: 'relay will ask the first time a channel event earns a notification',
  unsupported: 'not supported in this browser',
};

export function SettingsNotificationsSection({
  searchQuery,
  openNonce = 0,
}: {
  searchQuery: string;
  /**
   * Bumped every time the settings dialog is opened.
   *
   * `SettingsDialog` is rendered UNCONDITIONALLY from `App` into a native
   * `<dialog>` that `showModal` reveals — it never unmounts, so a mount-only
   * read would run once at app boot and never again. An operator who was
   * `denied` at boot and then re-allowed Relay in browser site settings would
   * be told they are blocked, with no enable button, for the rest of the tab's
   * life.
   */
  openNonce?: number;
}) {
  const settings = useNotifySettingsStore((state) => state.settings);
  const setNotifySetting = useNotifySettingsStore(
    (state) => state.setNotifySetting
  );
  const [permission, setPermission] =
    useState<NotifyPermissionState>('default');

  useEffect(() => {
    // READ, never request. `Notification.permission` is a plain property — the
    // prompt only ever comes from `requestPermission`, which this section fires
    // exclusively from the button below.
    setPermission(notifyPermissionState());
  }, [openNonce]);

  // Live updates while the dialog is already open: a lazy grant obtained from
  // the notify lane itself, or a change made in browser site settings, both land
  // here. Best effort — Safari has no `permissions.query` for notifications, and
  // the reject is swallowed because `openNonce` already covers the open path.
  useEffect(() => {
    const perms =
      typeof navigator === 'undefined' ? undefined : navigator.permissions;
    if (!perms || typeof perms.query !== 'function') return;
    let cancelled = false;
    let status: PermissionStatus | null = null;
    const onChange = () => setPermission(notifyPermissionState());
    void perms
      .query({ name: 'notifications' as PermissionName })
      .then((result) => {
        if (cancelled) {
          return;
        }
        status = result;
        result.addEventListener('change', onChange);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      status?.removeEventListener('change', onChange);
    };
  }, []);

  return (
    <section
      id="section-notifications"
      className={[
        'settings-dialog-section',
        !matchesSearch(searchQuery) ? 'dimmed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <h3 className="settings-dialog-section-heading">notifications</h3>
      <SettingRow
        name="Browser Notifications"
        description={PERMISSION_DESCRIPTION[permission]}
      >
        {permission === 'default' ? (
          <TuiButton
            variant="primary"
            size="sm"
            onClick={() => {
              // The gesture-backed path. Safari has always required a user
              // gesture for `requestPermission`, and Firefox has since 72 — so
              // the lazy first-event ask can be refused outright there, and
              // this button is the only grant that always works.
              void notifyOsNotifier().requestPermission().then(setPermission);
            }}
          >
            enable
          </TuiButton>
        ) : (
          <span className="setting-description">{permission}</span>
        )}
      </SettingRow>
      <SettingRow
        name="Channel Mentions"
        description="Notify when a channel message mentions @operator"
      >
        <TuiCheckbox
          checked={settings.mentions}
          onChange={(v) => setNotifySetting('mentions', v)}
        />
      </SettingRow>
      <SettingRow
        name="Direct Message Replies"
        description="Notify when an agent replies in a direct message channel"
      >
        <TuiCheckbox
          checked={settings.dmReplies}
          onChange={(v) => setNotifySetting('dmReplies', v)}
        />
      </SettingRow>
      <SettingRow
        name="Turn Complete"
        description="Notify when an agent finishes a turn in a channel you are not viewing"
      >
        <TuiCheckbox
          checked={settings.turnComplete}
          onChange={(v) => setNotifySetting('turnComplete', v)}
        />
      </SettingRow>
    </section>
  );
}

export default SettingsNotificationsSection;
