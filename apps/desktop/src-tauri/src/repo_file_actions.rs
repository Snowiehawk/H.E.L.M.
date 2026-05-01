use std::fs;
use std::path::Path;
use std::process::Command;

pub(crate) fn read_text_file(path: &Path, display_path: &str) -> Result<String, String> {
    fs::read_to_string(path).map_err(|err| format!("Unable to read {}: {}", display_path, err))
}

pub(crate) fn open_path_in_default_editor(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("File does not exist: {}", path.display()));
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(path);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let display = path.display().to_string();
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", &display]);
        command
    };

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    };

    command
        .status()
        .map_err(|err| format!("Unable to open {}: {}", path.display(), err))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!(
                    "Default editor command failed for {}",
                    path.display()
                ))
            }
        })
}

pub(crate) fn reveal_path_in_file_explorer(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("File does not exist: {}", path.display()));
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.args(["-R"]).arg(path);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let display = path.display().to_string();
        let mut command = Command::new("explorer");
        command.arg(format!("/select,{}", display));
        command
    };

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        let target = if path.is_dir() {
            path.to_path_buf()
        } else {
            path.parent().unwrap_or(path).to_path_buf()
        };
        command.arg(target);
        command
    };

    command
        .status()
        .map_err(|err| format!("Unable to reveal {}: {}", path.display(), err))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!(
                    "File explorer command failed for {}",
                    path.display()
                ))
            }
        })
}
