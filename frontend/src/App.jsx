import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./core/auth/AuthContext.jsx";
import { AppRoutes } from "./app/routing/AppRoutes.jsx";

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
