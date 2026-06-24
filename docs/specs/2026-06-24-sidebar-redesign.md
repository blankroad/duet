# 사이드바 재설계 — 설계

> 2026-06-24. 11개 섹션의 역할 혼재·중복 정리. 호스트 별명, 호스트/북마크 통합, 태그.
> 리서치(Transmit·ForkLift·Cyberduck·Termius·FileZilla·WinSCP·Finder·Dolphin·DOpus·
> One Commander) 기반. 결정: 별명 전파(사이드바+패널/상태바), 호스트+북마크 통합, 태그(다대다).

**상태**: 설계 승인 (2026-06-24) → 단계별 구현.

## 문제 (현재)

- **섹션 11개**, 역할 혼재. 호스트가 3중(ssh-config Hosts / Saved hosts / Host groups),
  저장 위치가 3중(Bookmarks / Host Favorites / Recent)으로 쪼개짐.
- 코드에 SSH 북마크→Favorites 자동 이관 로직 존재(`stores/bookmarks.ts`) = 이미 충돌 인지.
- **호스트 별명 불가**: ssh-config alias 읽기 전용, 접속 시 패널·상태바가 `user@host_ip`
  (IP)만 표시(`StatusBar.tsx:30`, `PathBar.tsx:73`).

## 목표 구조 (11 → 약 5 섹션)

| 섹션 | 내용 |
|---|---|
| **Tasks** | 작업 중일 때만(그대로) |
| **Places** | This PC 앵커 + 표준폴더 + Volumes(하위 묶음). 활성 패널 소스 적응 유지 |
| **Hosts** | ssh-config + saved 통합 1목록. 별명 편집, 상태 점, config/saved 배지. 태그 필터 |
| **Bookmarks** | 로컬+원격 통합(= Host Favorites 흡수). 단일 레코드(host+path+name). 태그 필터 |
| **Recent** | 자동·임시(그대로) |
| **Shelf** | 항목 있을 때만(그대로) |

## 핵심 모델 (리서치 결론)

- **이름 = 주소 분리**: 별명이 1순위 라벨, `user@host`는 부가정보. 별명 변경이 대상을 안 바꿈.
- **단일 북마크 레코드**: `bookmark = host + path + name (+ tags)`. "저장 호스트" = path `/` 인
  북마크. "원격 즐겨찾기" = path 있는 북마크. → Favorites/Bookmarks 중복 제거.
- **태그(다대다)**: 한 항목이 여러 태그에. 태그 필터 칩으로 좁히기(Cyberduck label).
- **라이브 vs 저장 분리**: 접속 세션은 상태 점으로 표시하되 저장 호스트와 같은 행에 통합(개인용).

---

## 단계 (value 순서)

### Phase 1 — 호스트 별명 (최우선 불편) ✅ 이번
- 백엔드 `services/host_nicknames.rs` — `<config>/duet/host-nicknames.json`,
  `{ alias: nickname }` 맵. commands `host_nickname_list/set/remove`.
  키 = 호스트 alias(config alias 또는 saved/ad-hoc alias) — 재접속에도 안정.
- 프론트 `stores/hostNicknames.ts` + `lib/hostLabel.ts`:
  `hostLabel(source)` — ssh면 connection alias → nickname ?? alias ?? `user@host_ip`.
- 라벨 전파: `StatusBar.tsx`, `PathBar.tsx`, Recent 의 alias 표시, Sidebar 호스트 행.
- 사이드바 호스트 행 인라인 rename(별명 편집).

### Phase 2 — Hosts 통합
- ssh-config Hosts + Saved hosts 한 목록. config/saved 배지, dedup(같은 alias 경고),
  상태 점, 별명 표시. Host groups → 태그로 흡수(Phase 4)하거나 유지.

### Phase 3 — Bookmarks 통합
- Host Favorites 를 Bookmarks 로 통합(단일 레코드, host alias 안정 참조). 데이터 이관.
  Favorites 섹션 제거. 원격 북마크는 host alias 로 navigate(필요 시 자동 접속).

### Phase 4 — 태그
- 북마크/호스트에 태그(다대다). `tags: Vec<String>`. 사이드바 상단 태그 필터 칩.
  기존 host-groups 는 태그로 마이그레이션 또는 폐기.

### Phase 5 — 섹션 정리
- Places + Volumes 묶기, This PC 앵커 흡수, 최종 순서·접힘 정리.

## 듀얼패널 affordance (전 단계 공통)

각 항목 클릭=활성 패널, Cmd/Ctrl+클릭=반대 패널(기존 유지). One Commander `[1][2]` 는 후속.

## 범위 밖 / 후속

호스트별 색상(WinSCP), 호스트별 기억된 경로(VS Code), 별명-주소 양방향 동기화,
그룹 단위 자격증명 상속(Termius).
