/**
 * App 루트 컴포넌트.
 *
 * MVP-0:
 * - 듀얼 패널 + 사이드바 토글
 * - 키보드 단축키 글로벌 핸들러
 * - 다크/라이트 모드 부트스트랩
 */
function App() {
  return (
    <div className="flex h-screen w-screen flex-col bg-base text-fg">
      <header className="flex h-9 items-center justify-between border-b border-border px-3">
        <span className="text-title font-medium">duet</span>
      </header>

      <main className="flex flex-1">
        {/* TODO: <Sidebar /> */}
        {/* TODO: <Pane id="left" /> */}
        {/* TODO: <Pane id="right" /> */}
        <div className="flex flex-1 items-center justify-center text-fg-muted">
          duet — not implemented yet. See ROADMAP.md
        </div>
      </main>

      <footer className="flex h-6 items-center border-t border-border px-3 text-meta text-fg-muted">
        {/* TODO: <StatusBar /> */}
        <span>0 items</span>
      </footer>
    </div>
  );
}

export default App;
