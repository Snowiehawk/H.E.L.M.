use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn atomic_write_text(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Path must include a parent folder: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("Unable to create {}: {}", parent.display(), err))?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let temp_path = unique_temp_file_path(parent, file_name)?;
    let write_result = (|| -> Result<(), String> {
        let mut temp_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|err| format!("Unable to create {}: {}", temp_path.display(), err))?;
        temp_file
            .write_all(content.as_bytes())
            .map_err(|err| format!("Unable to write {}: {}", temp_path.display(), err))?;
        temp_file
            .sync_all()
            .map_err(|err| format!("Unable to sync {}: {}", temp_path.display(), err))?;
        drop(temp_file);
        replace_file(&temp_path, path)?;
        sync_parent_directory(parent);
        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }

    write_result
}

fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), String> {
    replace_file_platform(temp_path, target_path).map_err(|err| {
        format!(
            "Unable to replace {} with {}: {}",
            target_path.display(),
            temp_path.display(),
            err
        )
    })
}

#[cfg(not(target_os = "windows"))]
fn replace_file_platform(temp_path: &Path, target_path: &Path) -> std::io::Result<()> {
    fs::rename(temp_path, target_path)
}

#[cfg(target_os = "windows")]
fn replace_file_platform(temp_path: &Path, target_path: &Path) -> std::io::Result<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    fn wide_null(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    let from = wide_null(temp_path.as_os_str());
    let to = wide_null(target_path.as_os_str());
    let replaced = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn unique_temp_file_path(parent: &Path, file_name: &str) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("Unable to read system time: {}", err))?
        .as_nanos();
    let process_id = std::process::id();
    for attempt in 0..100 {
        let candidate = parent.join(format!(
            ".{}.helm-tmp-{}-{}-{}",
            file_name, process_id, timestamp, attempt
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Unable to reserve a temporary file path in {}",
        parent.display()
    ))
}

pub(crate) fn unique_temp_sibling(parent: &Path) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("Unable to read system time: {}", err))?
        .as_nanos();
    let process_id = std::process::id();
    for attempt in 0..100 {
        let candidate = parent.join(format!(
            ".helm-new-project-{}-{}-{}",
            process_id, timestamp, attempt
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Unable to reserve a temporary project folder in {}",
        parent.display()
    ))
}

#[cfg(not(target_os = "windows"))]
fn sync_parent_directory(parent: &Path) {
    if let Ok(directory) = fs::File::open(parent) {
        let _ = directory.sync_all();
    }
}

#[cfg(target_os = "windows")]
fn sync_parent_directory(_parent: &Path) {
    // Rust stdlib does not expose a direct portable directory fsync on Windows.
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_project_parent(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after UNIX_EPOCH")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "helm-desktop-{}-{}-{}",
            label,
            std::process::id(),
            nonce
        ))
    }

    #[test]
    fn atomic_write_text_replaces_existing_file_without_temp_leftovers() {
        let repo_root = unique_test_project_parent("atomic-write");
        fs::create_dir_all(&repo_root).expect("test repo should be created");
        let target_path = repo_root.join("notes.txt");
        fs::write(
            &target_path,
            "old
",
        )
        .expect("test file should be written");

        atomic_write_text(
            &target_path,
            "new
",
        )
        .expect("atomic write should replace content");

        assert_eq!(
            fs::read_to_string(&target_path).expect("test file should be readable"),
            "new
"
        );
        let leftovers = fs::read_dir(&repo_root)
            .expect("test repo should be readable")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains("helm-tmp"))
            .count();
        assert_eq!(leftovers, 0);
        fs::remove_dir_all(repo_root).expect("test repo should be removed");
    }
}
