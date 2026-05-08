// Windows에서 콘솔 창 안 뜨게
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    duet_lib::run();
}
