//! 窗口图标（任务栏、标题栏、Alt+Tab）。
//!
//! Tauri 默认只取 icon.ico 的第一帧（16px）作为窗口图标，任务栏再把它放大到 32/40/48px，
//! 看起来发糊。这里改为从 exe 资源里的多尺寸图标（tauri-build 以 ID 32512 嵌入）
//! 按窗口当前 DPI 取最接近的那一帧，分别设置大图标和小图标。

use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON, LR_DEFAULTCOLOR, SM_CXICON,
    SM_CXSMICON, WM_SETICON,
};

/// tauri-build 嵌入应用图标时使用的资源 ID（IDI_APPLICATION）
const APP_ICON_ID: usize = 32512;

/// 按窗口当前 DPI 重新设置窗口图标；创建窗口后和 DPI 变化时调用。
pub(crate) fn apply<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as windows_sys::Win32::Foundation::HWND;
    unsafe {
        let dpi = GetDpiForWindow(hwnd);
        let hinst = GetModuleHandleW(std::ptr::null());
        for (kind, metric) in [(ICON_BIG, SM_CXICON), (ICON_SMALL, SM_CXSMICON)] {
            let size = GetSystemMetricsForDpi(metric, dpi);
            // 共享资源图标不用 LR_SHARED，由系统按尺寸挑选 ICO 中最合适的帧
            let icon = LoadImageW(
                hinst,
                APP_ICON_ID as *const u16,
                IMAGE_ICON,
                size,
                size,
                LR_DEFAULTCOLOR,
            );
            if !icon.is_null() {
                SendMessageW(hwnd, WM_SETICON, kind as usize, icon as isize);
            }
        }
    }
}
