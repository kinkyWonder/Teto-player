//! Thread priority helpers: background work must never compete with playback or the UI.
#[cfg(windows)]
mod imp {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentThread() -> isize;
        fn SetThreadPriority(h: isize, p: i32) -> i32;
    }
    const THREAD_MODE_BACKGROUND_BEGIN: i32 = 0x0001_0000;
    const THREAD_PRIORITY_TIME_CRITICAL: i32 = 15;
    const THREAD_PRIORITY_HIGHEST: i32 = 2;
    /// Lowest CPU priority + low I/O and memory priority (Windows "background mode").
    pub fn background() {
        unsafe {
            SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
        }
    }
    pub fn audio() {
        unsafe {
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
        }
    }
    pub fn high() {
        unsafe {
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
        }
    }
}
#[cfg(not(windows))]
mod imp {
    pub fn background() {}
    pub fn audio() {}
    pub fn high() {}
}
pub use imp::*;
