import { SearchIcon } from "../icons.jsx";
import { Input } from "./FormField.jsx";
import styles from "./SearchField.module.css";

export function SearchField({ value, onChange, placeholder = "Search…", ariaLabel = "Search" }) {
  return (
    <div className={styles.wrapper}>
      <SearchIcon className={styles.icon} width={16} height={16} />
      <Input
        type="search"
        className={styles.input}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
    </div>
  );
}
