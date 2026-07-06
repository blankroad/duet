import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DropTray } from "./windows/DropTray";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./i18n"; // App 보다 먼저 — useTranslation 사용 컴포넌트 대비
import "./styles/globals.css";

// 멀티윈도우 라우팅 — ?window=shelf 는 플로팅 드롭 트레이 루트만 렌더
// (App 을 마운트하지 않아 부트스트랩 IPC/이벤트 구독이 중복되지 않음).
const isShelf =
  new URLSearchParams(window.location.search).get("window") === "shelf";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>{isShelf ? <DropTray /> : <App />}</ErrorBoundary>
  </React.StrictMode>,
);
