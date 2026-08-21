import { Routes, Route, Navigate } from "react-router-dom";
import { AppShell } from "../layout/AppShell.jsx";
import { ProtectedRoute } from "./ProtectedRoute.jsx";
import { LoginPage } from "../../modules/auth/pages/LoginPage.jsx";
import { HomePage } from "../pages/HomePage.jsx";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<HomePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
