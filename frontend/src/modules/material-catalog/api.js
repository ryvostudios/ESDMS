import { apiClient } from "../../core/api/client.js";

export const listUnitsOfMeasure = () => apiClient.get("/material-catalog/units-of-measure");

export const listCatalog = (params = {}) => {
  const query = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== "")),
  ).toString();
  return apiClient.get(`/material-catalog${query ? `?${query}` : ""}`);
};

// The backend caps pageSize at 100 (material-catalog.validation.js). Asking
// for more is a 400, so a caller that needs the whole department catalog
// pages through it rather than guessing a bigger number — a department with
// more than 100 materials must not be silently truncated either.
export const CATALOG_MAX_PAGE_SIZE = 100;

// Hard stop so a bad `total` can never spin forever; far above any real
// department catalog, and the caller is told when it bites.
const CATALOG_MAX_PAGES = 50;

export async function listAllCatalog({ departmentId, includeInactive } = {}) {
  const rows = [];
  let page = 1;
  let total = 0;

  for (; page <= CATALOG_MAX_PAGES; page += 1) {
    const response = await listCatalog({
      departmentId,
      ...(includeInactive && { includeInactive: "true" }),
      page,
      pageSize: CATALOG_MAX_PAGE_SIZE,
    });
    rows.push(...response.data);
    total = response.meta?.total ?? rows.length;
    if (rows.length >= total || response.data.length < CATALOG_MAX_PAGE_SIZE) break;
  }

  return { data: rows, meta: { total, truncated: rows.length < total } };
}

export const searchCompanyItems = (q, departmentId) => {
  const params = new URLSearchParams({ q, ...(departmentId && { departmentId }) });
  return apiClient.get(`/material-catalog/company-items/search?${params.toString()}`);
};

export const addCatalogEntry = (body) => apiClient.post("/material-catalog", body);
export const updateCatalogEntry = (id, body) => apiClient.patch(`/material-catalog/${id}`, body);
