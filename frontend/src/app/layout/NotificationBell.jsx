import { useEffect, useRef, useState } from "react";
import { listNotifications } from "../../core/api/notifications.js";
import { useAuth } from "../../core/auth/AuthContext.jsx";
import { BellIcon } from "../../shared/icons.jsx";
import { formatDateTime } from "../../shared/utilities/datetime.js";
import styles from "./NotificationBell.module.css";

const BASE_POLL_INTERVAL_MS = 60_000;
const MAX_POLL_INTERVAL_MS = 5 * 60_000;
// Small randomized spread added to every scheduled poll (including a
// resume-from-hidden poll) so many clients that all became visible, or
// whose timers happened to align, at the same instant don't all fire on
// the exact same tick — see ESDMS-017 arithmetic in docs/DECISIONS.md.
const JITTER_MS = 5_000;

function withJitter(delayMs) {
  return Math.max(0, delayMs) + Math.floor(Math.random() * JITTER_MS);
}

// Per-user, not a single shared key — this app runs on shared devices (a
// gate kiosk/tablet across shifts), and a global key would leak one user's
// "seen" state to whoever logs in next.
function lastViewedKey(userId) {
  return `esdms.notifications.lastViewedAt.${userId}`;
}

function describe(notification) {
  if (notification.eventType === "GATE_PASS_APPROVED") {
    const { gatePassNumber, driverName, vehicleRegistration, destination } = notification.payload;
    return {
      title: `Gate Pass ${gatePassNumber} approved`,
      meta: `${driverName} · ${vehicleRegistration} → ${destination}`,
    };
  }

  return { title: notification.eventType, meta: "" };
}

export function NotificationBell() {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [open, setOpen] = useState(false);
  const [hasUnseen, setHasUnseen] = useState(false);
  const wrapperRef = useRef(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);

  // ESDMS-017: a fixed 30s setInterval kept polling at full cadence even
  // while the tab was backgrounded, and never backed off after a failure/
  // 429 — exactly the pattern that can exhaust a shared per-user or per-IP
  // budget for no operational benefit. This poller:
  //   - never polls at all while hidden, including the very first poll on
  //     mount if the tab starts out hidden;
  //   - guards against overlap with an explicit in-flight flag, not just
  //     timer bookkeeping — a slow/stalled request can never result in a
  //     second concurrent one;
  //   - doubles its delay (capped) after a failed request and resets to
  //     the base ~60s cadence on success;
  //   - adds a small random jitter to every scheduled delay, including a
  //     resume-from-hidden poll, so many clients don't all fire in lockstep;
  //   - collapses rapid hidden/visible/hidden toggles into at most one
  //     pending timer (each transition clears-then-reschedules the same
  //     timer, and a resume while a request is already in flight is a
  //     no-op) rather than stacking up multiple timers/requests.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer = null;
    let currentDelay = BASE_POLL_INTERVAL_MS;
    let lastPolledAt = 0;

    function scheduleNext(delay) {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      timer = setTimeout(refresh, withJitter(delay));
    }

    function refresh() {
      if (cancelled || inFlight) return;
      inFlight = true;
      lastPolledAt = Date.now();

      listNotifications()
        .then((response) => {
          if (cancelled) return;
          currentDelay = BASE_POLL_INTERVAL_MS;

          setNotifications(response.data);

          const lastViewedAt = localStorage.getItem(lastViewedKey(user.id));
          const newest = response.data[0]?.createdAt;
          setHasUnseen(Boolean(newest) && (!lastViewedAt || new Date(newest) > new Date(lastViewedAt)));
        })
        .catch(() => {
          // Silent — a failed notification poll shouldn't interrupt the
          // app. Back off instead of retrying at full cadence (a 429 in
          // particular means "slow down," not "try again immediately").
          currentDelay = Math.min(currentDelay * 2, MAX_POLL_INTERVAL_MS);
        })
        .finally(() => {
          inFlight = false;
          if (!cancelled) scheduleNext(currentDelay);
        });
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        clearTimeout(timer);
        return;
      }

      // A request is already in flight (started just before hidden, or a
      // rapid hidden->visible flicker mid-request) — its own .finally()
      // will schedule the next poll; scheduling another here would create
      // an overlapping/duplicate request.
      if (inFlight) return;

      const elapsed = Date.now() - lastPolledAt;
      scheduleNext(Math.max(0, BASE_POLL_INTERVAL_MS - elapsed));
    }

    if (document.visibilityState !== "hidden") {
      refresh();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [user.id]);

  useEffect(() => {
    if (!open) return undefined;

    function handleClickOutside(event) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  function handleToggle() {
    setOpen((prev) => !prev);

    if (!open) {
      setHasUnseen(false);
      if (notifications[0]) {
        localStorage.setItem(lastViewedKey(user.id), notifications[0].createdAt);
      }
    }
  }

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        type="button"
        ref={buttonRef}
        className={styles.button}
        onClick={handleToggle}
        aria-label="Notifications"
        aria-expanded={open}
        aria-controls="notifications-panel"
      >
        <BellIcon />
        {hasUnseen && <span className={styles.dot} aria-hidden="true" />}
      </button>

      {open && (
        // A disclosure panel of informational content, not a command menu
        // (nothing here is an actionable menuitem) — role="region" plus a
        // real list is the correct, simpler structure rather than
        // role="menu" over plain non-interactive <div> children.
        <div
          id="notifications-panel"
          className={styles.panel}
          role="region"
          aria-label="Notifications"
          ref={panelRef}
          tabIndex={-1}
        >
          <div className={styles.panelHeader}>Notifications</div>
          {notifications.length === 0 ? (
            <p className={styles.empty}>No notifications yet.</p>
          ) : (
            <ul className={styles.list}>
              {notifications.map((notification) => {
                const { title, meta } = describe(notification);
                return (
                  <li className={styles.item} key={notification.id}>
                    <p className={styles.itemTitle}>{title}</p>
                    {meta && <p className={styles.itemMeta}>{meta}</p>}
                    <p className={styles.itemMeta}>{formatDateTime(notification.createdAt)}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
