#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize)]
struct BackendHealth {
    mode: String,
    python_command: String,
    workspace_root: String,
    available: bool,
    note: String,
}

#[tauri::command]
fn backend_health() -> Result<BackendHealth, String> {
    let workspace_root = workspace_root()?;
    let python_command = resolve_python_command();
    let output = Command::new(&python_command)
        .arg("--version")
        .output()
        .map_err(|err| format!("Unable to launch {}: {}", python_command, err))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{} exited unsuccessfully", python_command)
        } else {
            stderr
        });
    }

    Ok(BackendHealth {
        mode: "live".to_string(),
        python_command,
        workspace_root: workspace_root.display().to_string(),
        available: true,
        note: "Desktop shell is connected to the Python backbone through a Tauri command bridge."
            .to_string(),
    })
}

#[tauri::command]
fn scan_repo_payload(repo_path: String) -> Result<Value, String> {
    let workspace_root = workspace_root()?;
    let src_root = workspace_root.join("src");
    let python_command = resolve_python_command();

    let output = Command::new(&python_command)
        .current_dir(&workspace_root)
        .env("PYTHONPATH", src_root)
        .env("PYTHONUNBUFFERED", "1")
        .arg("-m")
        .arg("helm.ui.desktop_bridge")
        .arg(&repo_path)
        .output()
        .map_err(|err| format!("Unable to launch {}: {}", python_command, err))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Python scan failed for {}", repo_path)
        } else {
            stderr
        });
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|err| format!("Unable to decode Python scan payload: {}", err))
}

#[tauri::command]
fn read_repo_file(file_path: String) -> Result<String, String> {
    fs::read_to_string(&file_path)
        .map_err(|err| format!("Unable to read {}: {}", file_path, err))
}

fn resolve_python_command() -> String {
    std::env::var("HELM_PYTHON_BIN").unwrap_or_else(|_| "python3".to_string())
}

fn workspace_root() -> Result<PathBuf, String> {
    if let Ok(explicit_root) = std::env::var("HELM_WORKSPACE_ROOT") {
        let path = PathBuf::from(explicit_root);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!(
            "HELM_WORKSPACE_ROOT does not exist: {}",
            path.display()
        ));
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest_dir
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf)
        .ok_or_else(|| "Unable to resolve workspace root.".to_string())?;

    if !root.exists() {
        return Err(format!(
            "Resolved workspace root does not exist: {}",
            root.display()
        ));
    }

    Ok(root)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            backend_health,
            scan_repo_payload,
            read_repo_file
        ])
        .run(tauri::generate_context!())
        .expect("failed to run H.E.L.M. desktop shell");
}
