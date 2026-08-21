import { Router } from "express";
import { login, me } from "./auth.controller.js";
import { authenticate } from "../../middleware/authenticate.js";
import { loginRateLimiter } from "../../middleware/rate-limit.js";

const router = Router();

router.post("/login", loginRateLimiter, login);
router.get("/me", authenticate, me);

export default router;
