# `platform/` — OS별 분기

## 책임

- OS별 코드 (`#[cfg(target_os = "...")]`)
- 휴지통 (`trash` crate, OS별 wrapping)
- 드라이브/볼륨 열거
- OS keychain (`keyring` crate)
- 경로 정규화 (macOS NFD ↔ NFC)
- 환경 정보 (홈, 설정 디렉토리)

## 의존성

- 위로: 없음
- 아래로: 없음
- 외부: `trash`, `dirs`, `keyring`, `unicode-normalization`

## 하지 말 것

- ❌ 다른 레이어에서 직접 호출 — `fs/`, `ssh/` 만 호출
- ❌ 한 OS만 가정 — cfg 분기 필수, 모든 OS에서 컴파일은 되어야 함

## 패턴

```rust
pub trait PlatformOps {
    fn list_drives() -> Vec<Drive>;
    fn move_to_trash(path: &Path) -> Result<()>;
    fn normalize_filename(name: &str) -> String;
    fn config_dir() -> PathBuf;
    fn keychain() -> Box<dyn Keychain>;
}

#[cfg(target_os = "linux")]
pub use linux::LinuxPlatform as Platform;

#[cfg(target_os = "macos")]
pub use macos::MacosPlatform as Platform;

#[cfg(target_os = "windows")]
pub use windows::WindowsPlatform as Platform;
```

## 윈도우 우선

본 프로젝트는 윈도우가 1순위 타겟. 윈도우 케이스를 가장 먼저 잡되,
`#[cfg]` 분기는 처음부터 깔끔하게 해두기 — 나중에 macOS / Linux 추가가 쉽게.

## 서브 모듈

```
platform/
├── mod.rs
├── unix.rs          # macOS + Linux 공통 (POSIX)
├── linux.rs
├── macos.rs
├── windows.rs
└── keychain.rs      # keyring crate wrapping
```
