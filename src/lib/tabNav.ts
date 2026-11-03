/**
 * 탭별 이동 세대(토큰) — 느린 SSH 에서 폴더 A 를 누른 직후 뒤로/다른 폴더를 누르면
 * 두 listDirectory 가 겹쳐 **늦게 도착한 쪽**이 이겼다("클릭했는데 다른 폴더가
 * 열림"). 이동을 시작할 때 토큰을 받고, 응답이 오면 그 토큰이 아직 최신인지 본다.
 *
 * 예전엔 패널 단위였다 — 그래서 다른 탭으로 전환만 해도(그 탭의 새로고침) 원래 탭의
 * 접속·아카이브 열기가 조용히 버려졌다. 대상 탭이 id 로 고정되므로 세대도 탭 단위다:
 * **같은 탭의** 더 새 이동만 이전 요청을 무효화한다.
 *
 * 아카이브 추출·휴지통 위치 조회처럼 목록을 읽기 전에 긴 작업이 있으면 그 작업을
 * 시작할 때 토큰을 받아, 긴 작업이 끝난 뒤에도 확인한다.
 *
 * **새로고침은 이동이 아니다** — `peekTabNav` 로 세대를 올리지 않고 엿보기만 한다.
 * 세대를 올리면 Ctrl+R·감시자 이벤트·그 탭으로 돌아오기 한 번에 진행 중인 아카이브
 * 열기·접속·느린 폴더 이동이 조용히 취소됐다.
 */
const seqByTab = new Map<string, number>();

/** 이 탭의 새 이동을 시작 — 반환 함수는 이 이동이 아직 최신인지 알려 준다. */
export function beginTabNav(tabId: string): () => boolean {
  const seq = (seqByTab.get(tabId) ?? 0) + 1;
  seqByTab.set(tabId, seq);
  return () => seqByTab.get(tabId) === seq;
}

/** 세대를 올리지 않고 지금 세대가 유지되는지만 본다 (새로고침용). */
export function peekTabNav(tabId: string): () => boolean {
  const seq = seqByTab.get(tabId) ?? 0;
  return () => (seqByTab.get(tabId) ?? 0) === seq;
}
