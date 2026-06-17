import { create } from "zustand";

/**
 * 전체 드라이브 파일명 인덱싱 진행 상태(전역). 백엔드 IndexProgressEvent 로 갱신.
 * 인덱스가 준비되면(done) 검색이 전체 드라이브를 즉시 커버한다.
 */
interface IndexStatusState {
  /** 지금까지 인덱싱한 파일 수. */
  indexed: number;
  /** 전체 드라이브 인덱싱 완료 여부. */
  done: boolean;
  setProgress: (indexed: number, done: boolean) => void;
}

export const useIndexStatus = create<IndexStatusState>((set) => ({
  indexed: 0,
  done: false,
  setProgress: (indexed, done) => set({ indexed, done }),
}));
