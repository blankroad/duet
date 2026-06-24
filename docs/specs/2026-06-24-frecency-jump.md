# frecency 점프 (zoxide 식) — 설계

> 2026-06-24. 자주·최근 방문한 디렉토리를 부분문자열로 즉시 점프. yazi/zoxide 의
> frecency(frequency + recency) 랭킹.

**상태**: 설계 (벤치마킹 후속 #3). 백엔드(작은 저장소) + 프론트(점퍼 UI).

## 문제

현재 위치 이동 자산은 ① 탭당 back/forward 히스토리(`Alt+←/→`), ② 북마크/즐겨찾기(수동
등록), ③ 사이드바 Recent(표시만)뿐. "자주 가는 그 폴더"를 이름 일부로 빠르게 점프하는
키보드 경로가 없다.

## 합의된 동작 (UX)

- 키 `Ctrl+J` → **점퍼** 입력창 → 부분문자열 입력 → frecency 상위 후보 리스트 →
  `↑/↓` 선택, `Enter` 로 **활성 패널** navigate. `Esc` 닫기.
- 후보는 디렉토리만. 로컬·원격(연결됨) 혼합 표시(source 라벨).
- 팔레트(`Ctrl+P`)와 **별개**: 팔레트는 명령/호스트/북마크 fuzzy, 점퍼는 방문 폴더 frecency 정렬.

## 점수 모델

```
score = ln(count + 1) * decay(now - last_visit)
decay(Δ) = 1/(1 + Δ_days)        # 단순·예측가능. 최근일수록 가중
```

- navigate 성공 시 해당 디렉토리 `count += 1`, `last_visit = now`.
- 저장 상한 1000(초과 시 score 하위 prune). 질의는 부분문자열(경로 + basename) 필터 후
  score 내림차순.

## 백엔드 (services + commands)

레이어: `services/frecency.rs` (신규) + `commands/` 등록(lib.rs `collect_commands`).

저장: `<config_dir>/duet/frecency.json` (원자적 write: tmp+rename, 다른 store 와 동일 패턴).

```rust
pub struct FrecencyEntry {
    pub location: Location,          // SourceId(local | ssh{host_ip,user}) + path
    pub count: u32,
    pub last_visit_ms: i64,
}

// commands (specta → bindings.ts 자동)
frecency_record(location: Location) -> ()                 // navigate 성공 시
frecency_query(query: String, limit: u32) -> Vec<FrecencyEntry>   // score desc
```

- 원격 키는 `host_ip + user + path` 로 구분(별칭 표기 차이 흡수 — SourceId 기존 규칙 재사용).
- score 계산은 backend(`now` 주입). 직접 경로 문자열 조작 금지 → `Location.path` 는 `PathBuf`.

## 프론트엔드

- `stores/frecency.ts`: 점퍼 열림 상태 + 후보 캐시.
- `navigate()` 성공 경로에서 `frecencyRecord(location)` 호출(디렉토리 한정). 기존 `recents`
  store 와 중복 기록이므로, recents 를 frecency 위에 얹는 통합도 검토(후속).
- `components/FrecencyJumper.tsx`: `CommandPalette` 레이아웃 재활용. 입력 → debounce →
  `frecencyQuery`. 항목 클릭/Enter → 활성 패널 navigate. 원격 항목은 source 칩 표시.

## 엣지/에러

- 사라진 경로: navigate 시 `list_directory` 실패 → 토스트 + 해당 엔트리 lazy prune.
- 미연결 원격 항목 선택: 표시는 하되 navigate 시 연결 필요(자동 재연결 연계는 후속).
- 동일 경로 대소문자/trailing slash 정규화(키 일관성).

## 범위 밖 (후속)

- 파일(디렉토리 외) frecency, 주소창 자동완성 통합.
- zoxide DB import, 가중치/감쇠 사용자 설정.
- recents store 완전 대체(우선은 병행).
