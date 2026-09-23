// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // claude CLI 的 statusLine 钩子会用这个参数拉起本程序（见 lib.rs 里
    // start_claude_session 的 --settings 构造）：从 stdin 读一段用量 JSON，
    // 写完文件立刻退出，不走下面完整的 Tauri 应用启动流程。
    if std::env::args().nth(1).as_deref() == Some("--statusline-write") {
        claudedeck_lib::statusline_write_hook();
        return;
    }
    claudedeck_lib::run()
}
