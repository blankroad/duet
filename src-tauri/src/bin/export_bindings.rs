//! Standalone TypeScript bindings exporter.
//!
//! `cargo run --bin export_bindings` 로 실행하면 `src/types/bindings.ts` 가
//! 현재 backend command 시그니처와 동기화된다. `pnpm tauri dev` 를 실행하지
//! 않고도 frontend 가 새 IPC command 의 타입을 즉시 사용 가능.
//!
//! `lib.rs::run()` 의 debug-build 자동 export 와 동일한 결과 — 차이는
//! "GUI 띄우지 않고 export 만" 가능하다는 점.

fn main() {
    let builder = duet_lib::make_specta_builder();
    duet_lib::export_bindings(&builder).expect("export bindings");
    println!("bindings written to src/types/bindings.ts");
}
