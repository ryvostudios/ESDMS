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

export function SearchIcon(props) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="M16 16l-3.5-3.5" />
    </svg>
  );
}

export function TruckIcon(props) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M2.5 6h8v8h-8z" />
      <path d="M10.5 9h3.5l2.5 2.5V14h-6z" />
      <circle cx="5.5" cy="15.5" r="1.5" />
      <circle cx="13.5" cy="15.5" r="1.5" />
    </svg>
  );
}

export function PlusIcon(props) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M10 4v12M4 10h12" />
    </svg>
  );
}

export function TrashIcon(props) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <path d="M4.5 6h11" />
      <path d="M8 6V4.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V6" />
      <path d="M6 6l.6 9a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L14 6" />
    </svg>
  );
}

export function ClipboardCheckIcon(props) {
  return (
    <svg {...base} {...props} aria-hidden="true">
      <rect x="4.5" y="3.5" width="11" height="14" rx="1.5" />
      <path d="M7.5 3.5V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v.5" />
      <path d="M7.5 10.5l1.8 1.8L13 8.5" />
    </svg>
  );
}
