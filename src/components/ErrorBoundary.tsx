import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * 최상위 에러 경계 — 렌더 중 에러로 앱이 **흰 화면**이 되는 것을 막는다. 복구 UI +
 * "상태 초기화"(localStorage 세션/UI 프리퍼런스 클리어 후 리로드) 제공.
 *
 * 한계: React ErrorBoundary 는 **렌더 중 동기 에러**만 잡는다(이벤트 핸들러/async
 * effect 는 못 잡음). 흰 화면(렌더 크래시)은 여기서 복구 가능. 파일/SSH 설정은
 * 백엔드 config 파일이라 초기화와 무관.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("duet render error:", error, info.componentStack);
  }

  private reset = () => {
    try {
      localStorage.clear();
    } catch {
      /* localStorage 불가 환경 — 무시 */
    }
    location.reload();
  };

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-base p-6 text-fg">
        <div className="text-title font-medium">duet ran into a problem</div>
        <div className="max-w-lg break-words text-center text-meta text-fg-muted">
          {this.state.error.message || "Unexpected error"}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => location.reload()}
            className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
          >
            Reload
          </button>
          <button
            type="button"
            onClick={this.reset}
            className="rounded bg-accent px-3 py-1 text-base text-white"
          >
            Reset app state &amp; reload
          </button>
        </div>
        <div className="max-w-md text-center text-meta text-fg-muted">
          Reset clears saved tabs/layout and local preferences — not your files or SSH
          config.
        </div>
      </div>
    );
  }
}
