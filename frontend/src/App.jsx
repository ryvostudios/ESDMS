import { useEffect, useState } from "react";

function App() {
  const [status, setStatus] = useState("Checking API...");

  useEffect(() => {
    fetch("http://127.0.0.1:3000/api/v1/health")
      .then((response) => {
        if (!response.ok) {
          throw new Error("API request failed");
        }

        return response.json();
      })
      .then((result) => {
        setStatus(result.data.status);
      })
      .catch(() => {
        setStatus("API unavailable");
      });
  }, []);

  return (
    <main>
      <h1>E-Set Digital Management System</h1>
      <p>API Status: {status}</p>
    </main>
  );
}

export default App;