import { Router } from "express";
import { login, logout, me, changePassword } from "./auth.controller.js";
import { authenticate } from "../../middleware/authenticate.js";
import { loginIpRateLimiter, loginAccountRateLimiter } from "../../middleware/rate-limit.js";

const router = Router();

router.post("/login", loginIpRateLimiter, loginAccountRateLimiter, login);
router.post("/logout", logout);
router.get("/me", authenticate, me);
router.post("/change-password", authenticate, loginIpRateLimiter, changePassword);

export default router;
