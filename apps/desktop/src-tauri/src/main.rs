#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::env;
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

#[derive(Clone, Serialize, Deserialize)]
struct StoredGraphNodePosition {
    x: f64,
    y: f64,
}

type StoredGraphNodeLayout = BTreeMap<String, StoredGraphNodePosition>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredGraphRerouteNode {
    id: String,
    edge_id: String,
    order: usize,
    x: f64,
    y: f64,
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct StoredGraphViewLayout {
    #[serde(default)]
    nodes: StoredGraphNodeLayout,
    #[serde(default)]
    reroutes: Vec<StoredGraphRerouteNode>,
}

#[derive(Default, Serialize, Deserialize)]
struct RepoGraphLayouts {
    views: BTreeMap<String, StoredGraphViewLayout>,
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
    run_bridge_json(["scan", &repo_path].as_slice())
}

#[tauri::command]
fn graph_view(repo_path: String, target_id: String, level: String, filters_json: String) -> Result<Value, String> {
    run_bridge_json(["graph-view", &repo_path, &target_id, &level, "--filters-json", &filters_json].as_slice())
}

#[tauri::command]
fn flow_view(repo_path: String, symbol_id: String) -> Result<Value, String> {
    run_bridge_json(["flow-view", &repo_path, &symbol_id].as_slice())
}

#[tauri::command]
fn apply_structural_edit(repo_path: String, request_json: String) -> Result<Value, String> {
    run_bridge_json(["apply-edit", &repo_path, "--request-json", &request_json].as_slice())
}

#[tauri::command]
fn reveal_source(repo_path: String, target_id: String) -> Result<Value, String> {
    run_bridge_json(["reveal-source", &repo_path, &target_id].as_slice())
}

#[tauri::command]
fn editable_node_source(repo_path: String, target_id: String) -> Result<Value, String> {
    run_bridge_json(["editable-source", &repo_path, &target_id].as_slice())
}

#[tauri::command]
fn save_node_source(repo_path: String, target_id: String, content_json: String) -> Result<Value, String> {
    run_bridge_json(["save-node-source", &repo_path, &target_id, "--content-json", &content_json].as_slice())
}

#[tauri::command]
fn read_repo_graph_layout(repo_path: String, view_key: String) -> Result<StoredGraphViewLayout, String> {
    let layouts = read_repo_graph_layouts(&repo_path)?;
    Ok(layouts.views.get(&view_key).cloned().unwrap_or_default())
}

#[tauri::command]
fn write_repo_graph_layout(repo_path: String, view_key: String, layout_json: String) -> Result<(), String> {
    let layout: StoredGraphViewLayout = serde_json::from_str(&layout_json)
        .map_err(|err| format!("Unable to decode graph layout payload: {}", err))?;
    let mut layouts = read_repo_graph_layouts(&repo_path)?;
    layouts.views.insert(view_key, layout);
    write_repo_graph_layouts(&repo_path, &layouts)
}

#[tauri::command]
fn read_repo_file(file_path: String) -> Result<String, String> {
    fs::read_to_string(&file_path).map_err(|err| format!("Unable to read {}: {}", file_path, err))
}

#[tauri::command]
fn open_path_in_default_editor(file_path: String) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!("File does not exist: {}", path.display()));
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&path);
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
        command.arg(&path);
        command
    };

    command
        .status()
        .map_err(|err| format!("Unable to open {}: {}", path.display(), err))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!("Default editor command failed for {}", path.display()))
            }
        })
}

#[tauri::command]
fn reveal_path_in_file_explorer(file_path: String) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!("File does not exist: {}", path.display()));
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.args(["-R"]).arg(&path);
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
            path.clone()
        } else {
            path.parent().unwrap_or(path.as_path()).to_path_buf()
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
                Err(format!("File explorer command failed for {}", path.display()))
            }
        })
}

fn run_bridge_json(args: &[&str]) -> Result<Value, String> {
    let workspace_root = workspace_root()?;
    let python_command = resolve_python_command();
    let python_path = python_path(&workspace_root)?;

    let output = Command::new(&python_command)
        .current_dir(&workspace_root)
        .env("PYTHONPATH", python_path)
        .env("PYTHONUNBUFFERED", "1")
        .arg("-m")
        .arg("helm.ui.desktop_bridge")
        .args(args)
        .output()
        .map_err(|err| format!("Unable to launch {}: {}", python_command, err))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Python bridge failed for {:?}", args)
        } else {
            stderr
        });
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|err| format!("Unable to decode Python bridge payload: {}", err))
}

fn python_path(workspace_root: &Path) -> Result<String, String> {
    let src_root = workspace_root.join("src");
    let vendor_root = workspace_root.join(".vendor").join("libcst");
    let joined = env::join_paths([src_root, vendor_root])
        .map_err(|err| format!("Unable to build PYTHONPATH: {}", err))?;
    joined
        .into_string()
        .map_err(|_| "Unable to encode PYTHONPATH for the Python bridge.".to_string())
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

fn repo_graph_layout_path(repo_path: &str) -> Result<PathBuf, String> {
    let repo_root = PathBuf::from(repo_path);
    if !repo_root.exists() {
        return Err(format!("Repository path does not exist: {}", repo_root.display()));
    }
    if !repo_root.is_dir() {
        return Err(format!("Repository path is not a directory: {}", repo_root.display()));
    }
    Ok(repo_root.join(".helm").join("graph-layouts.v1.json"))
}

fn read_repo_graph_layouts(repo_path: &str) -> Result<RepoGraphLayouts, String> {
    let layout_path = repo_graph_layout_path(repo_path)?;
    if !layout_path.exists() {
        return Ok(RepoGraphLayouts::default());
    }

    let raw = fs::read_to_string(&layout_path)
        .map_err(|err| format!("Unable to read {}: {}", layout_path.display(), err))?;
    let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    Ok(normalize_repo_graph_layouts(parsed))
}

fn write_repo_graph_layouts(repo_path: &str, layouts: &RepoGraphLayouts) -> Result<(), String> {
    let layout_path = repo_graph_layout_path(repo_path)?;
    if let Some(parent) = layout_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Unable to create {}: {}", parent.display(), err))?;
    }

    let serialized = serde_json::to_string_pretty(layouts)
        .map_err(|err| format!("Unable to encode graph layout file: {}", err))?;
    fs::write(&layout_path, serialized)
        .map_err(|err| format!("Unable to write {}: {}", layout_path.display(), err))
}

fn normalize_repo_graph_layouts(value: Value) -> RepoGraphLayouts {
    let mut layouts = RepoGraphLayouts::default();
    let Some(views) = value
        .get("views")
        .and_then(Value::as_object)
    else {
        return layouts;
    };

    views.iter().for_each(|(view_key, raw_layout)| {
        layouts
            .views
            .insert(view_key.clone(), normalize_graph_view_layout(raw_layout));
    });

    layouts
}

fn normalize_graph_view_layout(value: &Value) -> StoredGraphViewLayout {
    if let Some(object) = value.as_object() {
        if object.contains_key("nodes") || object.contains_key("reroutes") {
            return StoredGraphViewLayout {
                nodes: normalize_node_layout(object.get("nodes")),
                reroutes: normalize_reroutes(object.get("reroutes")),
            };
        }
    }

    StoredGraphViewLayout {
        nodes: normalize_node_layout(Some(value)),
        reroutes: Vec::new(),
    }
}

fn normalize_node_layout(value: Option<&Value>) -> StoredGraphNodeLayout {
    let mut layout = StoredGraphNodeLayout::new();
    let Some(entries) = value.and_then(Value::as_object) else {
        return layout;
    };

    entries.iter().for_each(|(node_id, position)| {
        let Some(object) = position.as_object() else {
            return;
        };

        let Some(x) = object.get("x").and_then(Value::as_f64) else {
            return;
        };
        let Some(y) = object.get("y").and_then(Value::as_f64) else {
            return;
        };

        layout.insert(node_id.clone(), StoredGraphNodePosition { x, y });
    });

    layout
}

fn normalize_reroutes(value: Option<&Value>) -> Vec<StoredGraphRerouteNode> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            let id = object.get("id")?.as_str()?.to_string();
            let edge_id = object.get("edgeId")?.as_str()?.to_string();
            let order = usize::try_from(object.get("order")?.as_u64()?).ok()?;
            let x = object.get("x")?.as_f64()?;
            let y = object.get("y")?.as_f64()?;

            Some(StoredGraphRerouteNode {
                id,
                edge_id,
                order,
                x,
                y,
            })
        })
        .collect()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            backend_health,
            scan_repo_payload,
            graph_view,
            flow_view,
            apply_structural_edit,
            reveal_source,
            editable_node_source,
            save_node_source,
            read_repo_graph_layout,
            write_repo_graph_layout,
            read_repo_file,
            open_path_in_default_editor,
            reveal_path_in_file_explorer
        ])
        .run(tauri::generate_context!())
        .expect("failed to run H.E.L.M. desktop shell");
}
