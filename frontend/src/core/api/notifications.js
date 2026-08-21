import { apiClient } from "./client.js";

export function listNotifications() {
  return apiClient.get("/notifications");
}
