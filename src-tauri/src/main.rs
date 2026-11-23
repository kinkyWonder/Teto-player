#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tide_lib::app::run();
}
