import type React from "react";

/**
 * 버튼의 기본 활성화 키(Enter/Space, 수식키 포함)를 그 버튼 몫으로 남긴다.
 *
 * 패널 목록의 키 처리(useKeyboardNav)는 window 에서 포커스와 무관하게 돌고
 * defaultPrevented 도 보지 않는다. 그래서 작업 바·상태바·상단바 버튼에 포커스를 두고
 * Enter 를 누르면 버튼 동작과 함께 **활성 패널의 커서 항목 열기**까지 실행됐다.
 * 바 컨테이너의 onKeyDown 에 달면 버튼 위에서 누른 활성화 키만 window 로 가지 않는다.
 */
export function keepButtonActivationLocal(e: React.KeyboardEvent): void {
  if (e.key !== "Enter" && e.key !== " ") return;
  const target = e.target as HTMLElement;
  if (target.closest('button, [role="button"]')) e.stopPropagation();
}

/**
 * 바 안의 컨트롤을 **마우스로** 누른 뒤엔 포커스를 내려놓는다(onClick 에 단다).
 * Windows(WebView2)는 클릭한 버튼이 포커스를 가져서, 그대로 두면 다음 Enter·화살표가
 * 패널 목록 대신 그 버튼(또는 사이드바)으로 간다. 입력칸은 타이핑하러 누른 것이니,
 * 키보드로 누른 경우(detail 0)는 의도한 포커스이니 그대로 둔다.
 */
export function releaseFocusAfterMouse(e: React.MouseEvent<HTMLElement>): void {
  if (e.detail === 0) return;
  const a = document.activeElement;
  if (
    a instanceof HTMLElement &&
    e.currentTarget.contains(a) &&
    a.tagName !== "INPUT" &&
    a.tagName !== "TEXTAREA"
  )
    a.blur();
}

/**
 * 모달 대화상자(Radix Dialog, role=dialog)가 열려 있나 — 그동안 window 키 처리기
 * (전역 단축키·패널 목록)는 뒤 패널을 건드리지 않는다. 포커스가 모달 안이거나,
 * 포커스를 잃어 body 에 있어도 모달이 문서에 있으면 열린 것으로 본다.
 */
export function modalDialogOpen(target: EventTarget | null): boolean {
  if (target instanceof Element && target.closest("[role='dialog']"))
    return true;
  return document.querySelector("[role='dialog']") !== null;
}
