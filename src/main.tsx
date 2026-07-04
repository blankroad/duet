import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n"; // App 보다 먼저 — useTranslation 사용 컴포넌트 대비
import "./styles/globals.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
