import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { requirePasswordChanged } from "../../shared/authorization/require-password-changed.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import * as controller from "./workforce-config.controller.js";

const router = Router();
router.use(authenticate);
router.use(requirePasswordChanged);
router.param("id", validateUuidParam("id"));

const MANAGE = requirePermission("workforce.configuration.manage");
// Anyone who can create/view employees needs to read the configuration
// catalog (which sections/fields/document types exist) even without the
// separate configuration-management permission.
const READ = requirePermission("workforce.configuration.manage", "employees.view", "employees.create", "profile.self.view");

router.get("/sections", READ, controller.listSections);
router.post("/sections", MANAGE, controller.createSection);
router.patch("/sections/:id", MANAGE, controller.updateSection);

router.get("/fields", READ, controller.listFields);
router.post("/fields", MANAGE, controller.createField);
router.patch("/fields/:id", MANAGE, controller.updateField);

router.get("/document-types", READ, controller.listDocumentTypes);
router.post("/document-types", MANAGE, controller.createDocumentType);
router.patch("/document-types/:id", MANAGE, controller.updateDocumentType);

export default router;
