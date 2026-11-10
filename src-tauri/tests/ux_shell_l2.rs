//! L2 backend validation repro (from shell-sol). Tempdir only.
//! UX-SHL-01 R2: shell_selection rejects `.`/`..` segments, so the pair below is refused.
use duet_lib::platform::shell_menu_core::shell_selection;

#[test]
fn dotdot_item_and_its_sibling_file_have_different_canonical_parents() {
    let tmp = tempfile::tempdir().unwrap();
    let sub = tmp.path().join("sub");
    std::fs::create_dir(&sub).unwrap();
    let file = sub.join("a.zip");
    std::fs::write(&file, b"fixture").unwrap();
    let other = sub.join("..");
    // Lexical parents match, but the directory item resolves to tmp itself;
    // its shell parent is tmp.parent(), not sub (the file's shell parent).
    assert_eq!(other.parent(), file.parent());
    assert_ne!(
        std::fs::canonicalize(&other).unwrap().parent(),
        std::fs::canonicalize(&file).unwrap().parent()
    );
    assert!(
        shell_selection(vec![other, file]).is_err(),
        "different resolved item parents were accepted for one GetUIObjectOf parent"
    );
}
