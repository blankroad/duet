fn main() {
    // Windows 앱 매니페스트를 직접 지정 — tauri 기본값 + longPathAware.
    // (non-Windows 타깃에서는 tauri-build 가 무시한다.)
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri-build");
}
