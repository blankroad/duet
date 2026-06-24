# 그리드/타일 썸네일 — 설계

> 2026-06-24. 그리드/타일 뷰에서 타입 아이콘 대신 이미지 썸네일 표시. lazy 생성 + 캐시.
> yazi / Finder Gallery / Commander One Thumbs 계열. **1차는 이미지(순수 Rust) only.**

**상태**: 설계 (벤치마킹 후속 #5). 백엔드(생성·캐시) + 프론트(그리드 통합).
**의존성 승인 필요**: `image` 크레이트(§6) — 아래 참조.

## 문제

그리드/타일 뷰가 확장자 기반 아이콘만 표시 → 사진/디자인 폴더 탐색이 약하다. 미리보기
패널(`F11`)·Quick Look(`Space`)은 **단건**만 보여줘 "한눈에 훑기"가 안 된다.

## 합의된 동작 (UX)

- 그리드/타일 뷰에서 **이미지 파일**(png/jpg/jpeg/gif/webp/avif/bmp)은 썸네일로 표시.
- **보이는 셀만** lazy 생성(IntersectionObserver), 생성된 건 캐시 → 재방문 즉시.
- 로딩 중/실패/비대상 타입은 기존 타입 아이콘 fallback.
- 설정 토글 `show_thumbnails`(기본 ON). 디테일 뷰는 영향 없음(아이콘 유지).

## 의존성 (§6 승인 대상)

- **`image`** (순수 Rust 디코드/리사이즈). recent/total 다운로드·대안(zune-image 등) 검토
  표를 승인 요청 시 첨부. **영상 썸네일은 ffmpeg 외부 바이너리 필요 → §9/§"바이너리
  미사용" 충돌 → 범위 밖(별도 결정).**
- PDF 첫 페이지 썸네일도 1차 범위 밖(프론트 pdfjs 렌더 캐싱 or 백엔드 크레이트 — 후속).

## 백엔드 (services + 프로토콜)

레이어: `services/thumbnail.rs` (신규) + 기존 `preview_stream` 의 커스텀 프로토콜 확장.

- 프로토콜: 기존 `duet-preview://` 에 **썸네일 모드** 추가(쿼리 `?thumb=256`) 또는 신규
  `duet-thumb://`. URL 은 기존과 동일하게 source/path 를 hex 인코딩.
- 생성 파이프라인:
  1. 캐시 키 = `hash(source_id + path + mtime_ms + size)`.
  2. 캐시 hit → `<config_dir>/duet/thumbs/<key>.webp` 반환.
  3. miss → 원본 디코드 → 최대 변(예 256px) 리사이즈 → **EXIF orientation 보정** →
     webp 인코드 → 캐시 write → 반환.
- 원격(SFTP): 작은 이미지는 전체 `read`, 큰 이미지는 read_range 로 헤더만 가져와 크기 확인
  후 임계(예 20MB) 초과면 생성 스킵(아이콘 fallback). same-host 정신 유지(전체 다운로드 회피).
- 동시 생성 제한: 세마포어(예 4) — UI 스크롤 폭주 시 백엔드 보호. 별도 task 풀(작업 큐와 분리).
- 캐시 상한: 디렉토리 크기 LRU 정리(예 500MB), 앱 시작 시 점검.

## 프론트엔드

- `stores/settings.ts`: `show_thumbnails` 토글(설정 General 섹션).
- `components/pane/EntryGrid.tsx` / `EntryRow.tsx`(타일): 썸네일 대상 타입이고 설정 ON 이면
  `<img loading="lazy" src={thumbUrl(entry)}>` + IntersectionObserver(가상 스크롤과 호환).
  `onError` → 타입 아이콘 fallback.
- `lib/previewUrl.ts`: `thumbUrl(entry, size)` 추가(기존 preview URL 빌더 재사용).
- 가상 스크롤(`@tanstack/react-virtual`) overscan 내에서만 요청 — 화면 밖 대량 요청 방지.

## 엣지/에러

- 애니메이션 GIF/WebP → 첫 프레임.
- SVG → 1차는 아이콘 fallback(래스터화 후속).
- 깨진/0바이트 이미지 → 아이콘 fallback, 캐시에 "실패" 마킹해 재시도 폭주 방지.
- 원격 연결 끊김 중 → 생성 보류, 재연결 후 표시.

## 범위 밖 (후속)

- **영상 썸네일(ffmpeg)** — 외부 바이너리 정책 결정 필요.
- PDF 첫 페이지 썸네일.
- 썸네일 크기 사용자 설정, gallery 전용 뷰, EXIF/메타데이터 패널(별도 spec).
