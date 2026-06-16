# Places/Volumes — 활성 패널 소스 적응

> 2026-06-16. 사이드바 Places/Volumes 가 활성 패널의 시스템(로컬/원격)에 맞춰 동작.

## 문제

현재 `places()`/`volumes()` 는 **로컬 머신 전용**(`dirs` crate, 로컬 FS), 시작 시 1회 로드.
`PlaceItem` 클릭은 무조건 `localLocation(path)` 로 navigate. 활성 패널이 원격(SSH)이어도
로컬 경로로 이동 → 원격에서 깨짐. 사용자는 "왼쪽=원격 Mac, 오른쪽=로컬 Windows 면
활성 패널에 따라 Places 가 맞춰지길" 원함.

## 합의된 동작 (UX)

- 사이드바 Places/Volumes = **활성 패널 소스 것만** 표시. 포커스 전환 시 즉시 교체.
- Place/Volume 클릭 → **활성 패널 소스로** 그 경로 navigate (로컬→local, 원격→해당 connection).

## 백엔드 (commands/system.rs — 순수 SFTP, exec 없음)

- `ssh_places(connection_id) -> Vec<Place>`: 원격 home(`SshFs::home`) +
  `$HOME/{Desktop,Documents,Downloads,Pictures,Movies}` 중 **`metadata` 로 존재 확인된 dir** 만.
- `ssh_volumes(connection_id) -> Vec<Volume>`: `/Volumes`(mac)·`/mnt`·`/media`·`/media/<user>`
  를 `SshFs::list` 시도, 되는 root 의 dir 엔트리를 볼륨으로 (path 로 dedup). 없는 root 는 skip
  → OS 판별 불필요.
- 로컬 `places()`/`volumes()` 그대로. `uname`/exec 안 씀 → §9 무관.

## 프론트엔드 (store + Sidebar)

- `usePlaces`: `places/volumes` → `bySource: Record<SourceKey, { places, volumes }>`.
  `SourceKey` = `"local"` | `connection_id`.
- 활성 pane 의 source 로 `bySource[key]` 선택해 렌더. activePane 변경에 반응.
- 연결 open 시 `ssh_places`/`ssh_volumes` fetch + 캐시. close 시 evict. (포커스 전환은 캐시 선택만 →
  재조회·깜빡임 없음. Volumes 는 on-demand refresh 유지.)
- `PlaceItem`/`TrashItem` 클릭: `localLocation` 고정 → source 맞춤 location 빌더로.

## 엣지/에러

- 원격 조회 실패: 최소 Home 만(빈 섹션 허용). `/Volumes` 등 없는 root 는 조용히 skip.
- Trash place: 별도(이미 처리 — Windows 는 시스템 휴지통 탐색기, mac/linux/원격은 navigate).

## 범위 밖 (후속)

- 원격 XDG 로컬라이즈된 폴더명, 마운트 실시간 감지, 채널 재사용 최적화.
