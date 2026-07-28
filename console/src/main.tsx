import React from "react";
import ReactDOM from "react-dom/client";
import { AuthProvider } from "./lib/auth";
import { App } from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>,
);
