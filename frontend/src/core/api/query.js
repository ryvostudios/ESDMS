export function buildQuery(params = {}) {
  const query = new URLSearchParams();

  for (const [key, rawValue] of Object.entries(params)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value === undefined || value === null || value === "") continue;
      query.append(key, String(value));
    }
  }

  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}
