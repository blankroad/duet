//! OS별 분기. 다른 레이어는 `fs/`, `ssh/` 통해서만 접근.

// TODO:
// #[cfg(unix)] pub mod unix;
// #[cfg(target_os = "linux")] pub mod linux;
// #[cfg(target_os = "macos")] pub mod macos;
// #[cfg(target_os = "windows")] pub mod windows;
// pub mod keychain;
//
// #[cfg(target_os = "linux")] pub use linux::LinuxPlatform as Platform;
// #[cfg(target_os = "macos")] pub use macos::MacosPlatform as Platform;
// #[cfg(target_os = "windows")] pub use windows::WindowsPlatform as Platform;
