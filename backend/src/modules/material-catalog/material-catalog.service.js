import { withTransaction } from "../../shared/db/with-transaction.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../shared/errors/app-error.js";
import { findDepartmentById } from "../departments/departments.repository.js";
import {
  resolveCatalogDepartmentId,
  resolveListDepartmentScope,
  assertCatalogEntryManageable,
} from "./material-catalog.authorization.js";
import {
  listActiveUnitsOfMeasure,
  findCompanyItemById,
  findCompanyItemByNormalizedName,
  searchCompanyItems,
  findSimilarCompanyItems,
  insertCompanyItem,
  catalogEntryExists,
  insertCatalogEntry,
  findCatalogEntryById,
  updateCatalogEntryFields,
  hasActiveCatalogEntries,
  updateCompanyItemFields,
  listCatalogForDepartment,
} from "./material-catalog.repository.js";

async function assertDepartmentUsable(departmentId) {
  const department = await findDepartmentById(departmentId);
  if (!department || !department.is_active) {
    throw new ValidationError("Invalid department.");
  }
}

export function listUnitsOfMeasure() {
  return listActiveUnitsOfMeasure();
}

export async function listCatalog(actor, { departmentId, search, includeInactive, page, pageSize }) {
  const { departmentId: scope, unfiltered } = resolveListDepartmentScope(actor, departmentId);

  // A scoped actor with no department assigned has nothing to show — this
  // must short-circuit here rather than reach the repository, where a null
  // scope means "unfiltered" (see material-catalog.authorization.js).
  if (!unfiltered && !scope) {
    return { rows: [], total: 0 };
  }

  const canSeeInactive = includeInactive === "true" && actor.permissions.has("material_catalog.manage");

  return listCatalogForDepartment(scope, {
    search,
    includeInactive: canSeeInactive,
    page,
    pageSize,
  });
}

export async function searchItems(actor, { q, departmentId }) {
  const { departmentId: scope } = resolveListDepartmentScope(actor, departmentId);
  return searchCompanyItems(q, scope);
}

export async function createCatalogEntry(actor, input) {
  const departmentId = resolveCatalogDepartmentId(actor, input.departmentId);
  await assertDepartmentUsable(departmentId);

  return withTransaction(async (client) => {
    let companyItem;
    let possibleDuplicates = [];

    if (input.companyItemId) {
      companyItem = await findCompanyItemById(input.companyItemId);
      if (!companyItem || !companyItem.is_active) {
        throw new ValidationError("Invalid company item.");
      }
    } else {
      // A Company Item is the GLOBAL physical identity, and previous-purchase
      // price comparison keys on its exact id. An exact normalized match is
      // therefore not a "possible duplicate" to warn about — it IS the same
      // item, and creating a second identity for it permanently fragments
      // that item's purchase history.
      //
      // This check previously existed inverted: the warning list explicitly
      // FILTERED OUT exact-name matches, so the one case that had to be
      // caught was the only one silently allowed.
      const existing = await findCompanyItemByNormalizedName(input.newItem.name, client);
      if (existing) {
        throw new ConflictError(
          existing.is_active
            ? `"${existing.name}" already exists as a company item. Add that item to this department's catalog instead of creating a second one.`
            : `"${existing.name}" already exists as an archived company item. Restore it instead of creating a second one, so its purchase history stays intact.`,
        );
      }

      // Similar-but-different names stay a warning, never a block: two
      // genuinely distinct materials may legitimately have similar names, and
      // deciding they are the same physical thing is a business judgement
      // (docs/INVERSE_ACTION_AUDIT.md). Only the exact normalized identity
      // above is enforced.
      possibleDuplicates = await findSimilarCompanyItems(input.newItem.name, departmentId);

      companyItem = await insertCompanyItem(client, {
        name: input.newItem.name,
        description: input.newItem.description,
        createdByUserId: actor.id,
      });
    }

    if (await catalogEntryExists(departmentId, companyItem.id)) {
      throw new ConflictError("This material is already in the department catalog.");
    }

    const entry = await insertCatalogEntry(client, {
      departmentId,
      companyItemId: companyItem.id,
      defaultUomId: input.defaultUomId,
      createdByUserId: actor.id,
    });

    return { entry, companyItem, possibleDuplicates };
  });
}

export async function updateCatalogEntry(actor, id, input) {
  const entry = await findCatalogEntryById(id);
  if (!entry) throw new NotFoundError("Catalog entry not found.");

  assertCatalogEntryManageable(actor, entry);

  if (input.isActive === true) {
    const companyItem = await findCompanyItemById(entry.company_item_id);
    if (!companyItem?.is_active) {
      throw new ConflictError("Reactivate the Company Item before restoring it to a department catalog.");
    }
  }

  return updateCatalogEntryFields(id, input);
}

export async function updateCompanyItem(actor, id, input) {
  if (actor.role !== "CEO" && !actor.permissions.has("material_catalog.all_departments")) {
    throw new ForbiddenError("Company-wide material management permission is required.");
  }

  return withTransaction(async (client) => {
    const item = await findCompanyItemById(id, client);
    if (!item) throw new NotFoundError("Company item not found.");

    // A rename must not be able to collide two identities together. The
    // database index is the authority either way; checking here turns what
    // would be a unique-violation 500 into the same actionable conflict the
    // create path gives.
    if (input.name !== undefined) {
      const existing = await findCompanyItemByNormalizedName(input.name, client);
      if (existing && existing.id !== id) {
        throw new ConflictError(`"${existing.name}" already exists as a company item.`);
      }
    }

    if (input.isActive === false && item.is_active && await hasActiveCatalogEntries(id, client)) {
      throw new ConflictError("Remove this material from every active department catalog before archiving the Company Item.");
    }

    return updateCompanyItemFields(client, id, input);
  });
}
