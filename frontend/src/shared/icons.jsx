// Hand-rolled instead of an icon library dependency — the shell only
// needs a handful of simple line icons.
const base = {
  width: 20,
  height: 20,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

export function MenuIcon(props) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M3 5h14M3 10h14M3 15h14" />
    </svg>
  );
}

export function CloseIcon(props) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M5 5l10 10M15 5L5 15" />
    </svg>
  );
}

export function HomeIcon(props) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M3.5 9.5 10 4l6.5 5.5" />
      <path d="M5.5 8.5V16h9V8.5" />
    </svg>
  );
}

export function LogoutIcon(props) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
      <path d="M13 14l3.5-4L13 6" />
      <path d="M16.5 10H8" />
    </svg>
  );
}
