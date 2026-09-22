<script lang="ts">
  import { readableAPIError } from "../../lib/api";
  import {
    appleDevice,
    deviceLabel,
    installedToHomeScreen,
    pushSupported,
  } from "../../lib/push-capability";
  import {
    currentPushSubscription,
    ensurePushSubscription,
    fetchPushState,
    forgetSubscription,
    readPushEnabled,
    registerPushWorker,
    storeSubscription,
    writePushEnabled,
  } from "../../lib/webPush";
  import type { User } from "../../lib/types";

  type Props = {
    user: User;
    isDesktop?: boolean;
  };

  let { user, isDesktop = false }: Props = $props();

  let available = $state(false);
  let supported = $state(false);
  let enabled = $state(false);
  let busy = $state(false);
  let status = $state("");
  let statusError = $state(false);

  $effect(() => {
    void load(user.id, isDesktop);
  });

  async function load(userID: string, desktop: boolean) {
    if (desktop) {
      // The desktop app denies every permission request and shows its own
      // notifications, so the row would be a dead switch there.
      available = false;
      return;
    }
    supported = pushSupported();
    try {
      const state = await fetchPushState();
      available = state.enabled;
      if (!state.enabled) return;
      const subscription = supported ? await currentPushSubscription() : null;
      enabled = Boolean(subscription) && readPushEnabled(userID);
      // A device whose subscription is gone is off here, whatever this
      // browser remembered.
      if (!subscription && readPushEnabled(userID)) writePushEnabled(userID, false);
    } catch {
      available = false;
    }
  }

  async function setEnabled(next: boolean) {
    status = "";
    statusError = false;
    busy = true;
    try {
      if (next) await turnOn();
      else await turnOff();
    } catch (error) {
      enabled = false;
      status = readableAPIError(error, "Push notifications could not be turned on");
      statusError = true;
    } finally {
      busy = false;
    }
  }

  async function turnOn() {
    const state = await fetchPushState();
    if (!state.enabled) {
      available = false;
      return;
    }
    // The switch click is the user gesture the permission prompt needs.
    const permission = Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
    if (permission !== "granted") {
      enabled = false;
      status = permission === "denied"
        ? "Notifications are blocked for this site. Allow them in your browser settings, then try again."
        : "Notifications were not enabled.";
      statusError = true;
      return;
    }
    const registration = await registerPushWorker();
    const subscription = await ensurePushSubscription(registration, state.vapid_public_key);
    await storeSubscription(subscription);
    writePushEnabled(user.id, true);
    enabled = true;
    status = "On for this device";
  }

  async function turnOff() {
    const subscription = await currentPushSubscription();
    writePushEnabled(user.id, false);
    enabled = false;
    if (!subscription) return;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await forgetSubscription(endpoint);
    status = "Off for this device";
  }

  const needsInstall = $derived(!supported && appleDevice() && !installedToHomeScreen());
</script>

{#if available}
  <div class="settings-row2 settings-row2--toggle">
    <div class="settings-row2__desc">
      <label class="settings-row2__label" for="notifications-push">Push notifications on this device</label>
      <p class="settings-row2__hint">Receive alerts when the app is closed.</p>
      {#if needsInstall}
        <p class="settings-row2__hint">
          Add ClickClack to your Home Screen from the Share menu, then open it from there to turn this on.
        </p>
      {:else if !supported}
        <p class="settings-row2__hint is-error">This browser does not support push notifications.</p>
      {:else if enabled}
        <p class="settings-row2__hint">On for {deviceLabel()}</p>
      {/if}
      {#if status}
        <p class="settings-row2__hint" class:is-error={statusError} role="status">{status}</p>
      {/if}
    </div>
    <div class="settings-row2__control settings-row2__control--end">
      <input
        id="notifications-push"
        type="checkbox"
        class="settings-switch"
        aria-label="Push notifications on this device"
        disabled={!supported || busy}
        checked={enabled}
        onchange={(event) => void setEnabled(event.currentTarget.checked)}
      />
    </div>
  </div>
{/if}
