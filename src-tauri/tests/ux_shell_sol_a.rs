//! Shell smoke repros: fixture-only paths, no real app or user file is opened.

#[cfg(target_os = "macos")]
#[test]
#[ignore = "UX-SHL-10 repro: missing configured app must report launch failure"]
fn missing_open_with_app_reports_failure() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("document.txt");
    std::fs::write(&file, b"fixture").unwrap();
    let missing = temp.path().join("DefinitelyMissingDuetSmokeApp.app");
    let result = duet_lib::platform::open_with(&missing, &file);
    assert!(
        result.is_err(),
        "missing configured app was reported as successfully opened"
    );
}
