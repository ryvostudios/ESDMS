import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { list } from "./departments.controller.js";

const router = Router();

router.get("/", authenticate, list);

export default router;
