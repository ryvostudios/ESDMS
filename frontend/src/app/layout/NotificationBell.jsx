import { useEffect, useRef, useState } from "react";
import { listNotifications } from "../../core/api/notifications.js";
import { useAuth } from "../../core/auth/AuthContext.jsx";
import { BellIcon } from "../../shared/icons.jsx";
import { formatDateTime } from "../../shared/utilities/datetime.js";
import styles from "./NotificationBell.module.css";

const POLL_INTERVAL_MS = 30_000;

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

  useEffect(() => {
    let cancelled = false;

    function refresh() {
      listNotifications()
        .then((response) => {
          if (cancelled) return;

          setNotifications(response.data);

          const lastViewedAt = localStorage.getItem(lastViewedKey(user.id));
          const newest = response.data[0]?.createdAt;
          setHasUnseen(Boolean(newest) && (!lastViewedAt || new Date(newest) > new Date(lastViewedAt)));
        })
        .catch(() => {
          // Silent — a failed notification poll shouldn't interrupt the app.
        });
    }

    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
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
