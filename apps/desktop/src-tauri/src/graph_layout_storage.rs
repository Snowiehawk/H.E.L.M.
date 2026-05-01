use crate::atomic_file::atomic_write_text;
use crate::repo_boundary::ensure_canonical_path_inside_repo;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct StoredGraphNodePosition {
    x: f64,
    y: f64,
}

pub(crate) type StoredGraphNodeLayout = BTreeMap<String, StoredGraphNodePosition>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredGraphRerouteNode {
    id: String,
    edge_id: String,
    order: usize,
    x: f64,
    y: f64,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredGraphGroup {
    id: String,
    title: String,
    #[serde(default)]
    member_node_ids: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
pub(crate) struct StoredGraphViewLayout {
    #[serde(default)]
    pub(crate) nodes: StoredGraphNodeLayout,
    #[serde(default)]
    pub(crate) reroutes: Vec<StoredGraphRerouteNode>,
    #[serde(default)]
    pub(crate) pinned_node_ids: Vec<String>,
    #[serde(default)]
    pub(crate) groups: Vec<StoredGraphGroup>,
}

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct RepoGraphLayouts {
    pub(crate) views: BTreeMap<String, StoredGraphViewLayout>,
}

pub(crate) fn repo_graph_layout_path(repo_root: &Path) -> Result<PathBuf, String> {
    let layout_path = repo_root.join(".helm").join("graph-layouts.v1.json");
    if layout_path.exists() {
        let canonical_layout = layout_path.canonicalize().map_err(|err| {
            format!(
                "Unable to resolve graph layout file {}: {}",
                layout_path.display(),
                err
            )
        })?;
        ensure_canonical_path_inside_repo(&canonical_layout, repo_root, "Graph layout file")?;
        return Ok(layout_path);
    }

    let mut nearest_parent = layout_path
        .parent()
        .ok_or_else(|| "Graph layout path must include a parent folder.".to_string())?
        .to_path_buf();
    while !nearest_parent.exists() {
        let parent = nearest_parent
            .parent()
            .ok_or_else(|| "Unable to resolve graph layout parent folder.".to_string())?;
        nearest_parent = parent.to_path_buf();
    }

    let canonical_parent = nearest_parent.canonicalize().map_err(|err| {
        format!(
            "Unable to resolve graph layout parent folder {}: {}",
            nearest_parent.display(),
            err
        )
    })?;
    ensure_canonical_path_inside_repo(&canonical_parent, repo_root, "Graph layout parent folder")?;
    Ok(layout_path)
}

pub(crate) fn read_repo_graph_layouts(repo_root: &Path) -> Result<RepoGraphLayouts, String> {
    let layout_path = repo_graph_layout_path(repo_root)?;
    if !layout_path.exists() {
        return Ok(RepoGraphLayouts::default());
    }

    let raw = fs::read_to_string(&layout_path)
        .map_err(|err| format!("Unable to read {}: {}", layout_path.display(), err))?;
    let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    Ok(normalize_repo_graph_layouts(parsed))
}

pub(crate) fn write_repo_graph_layouts(
    repo_root: &Path,
    layouts: &RepoGraphLayouts,
) -> Result<(), String> {
    let layout_path = repo_graph_layout_path(repo_root)?;
    if let Some(parent) = layout_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Unable to create {}: {}", parent.display(), err))?;
    }

    let serialized = serde_json::to_string_pretty(layouts)
        .map_err(|err| format!("Unable to encode graph layout file: {}", err))?;
    atomic_write_text(&layout_path, &serialized)
}

fn normalize_repo_graph_layouts(value: Value) -> RepoGraphLayouts {
    let mut layouts = RepoGraphLayouts::default();
    let Some(views) = value.get("views").and_then(Value::as_object) else {
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
        if object.contains_key("nodes")
            || object.contains_key("reroutes")
            || object.contains_key("pinnedNodeIds")
            || object.contains_key("groups")
        {
            return StoredGraphViewLayout {
                nodes: normalize_node_layout(object.get("nodes")),
                reroutes: normalize_reroutes(object.get("reroutes")),
                pinned_node_ids: normalize_pinned_node_ids(object.get("pinnedNodeIds")),
                groups: normalize_groups(object.get("groups")),
            };
        }
    }

    StoredGraphViewLayout {
        nodes: normalize_node_layout(Some(value)),
        reroutes: Vec::new(),
        pinned_node_ids: Vec::new(),
        groups: Vec::new(),
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

fn normalize_pinned_node_ids(value: Option<&Value>) -> Vec<String> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| item.as_str().map(ToOwned::to_owned))
        .collect()
}

fn normalize_groups(value: Option<&Value>) -> Vec<StoredGraphGroup> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            let id = object.get("id")?.as_str()?.to_string();
            let title = object.get("title")?.as_str()?.to_string();
            let member_node_ids = object
                .get("memberNodeIds")?
                .as_array()?
                .iter()
                .filter_map(|member| member.as_str().map(ToOwned::to_owned))
                .collect();

            Some(StoredGraphGroup {
                id,
                title,
                member_node_ids,
            })
        })
        .collect()
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
    fn graph_layout_path_stays_under_helm_directory_in_active_repo() {
        let repo_root = unique_test_project_parent("layout-path");
        fs::create_dir_all(&repo_root).expect("test repo should be created");
        let canonical_repo = repo_root
            .canonicalize()
            .expect("test repo should canonicalize");

        let layout_path =
            repo_graph_layout_path(&canonical_repo).expect("layout path should stay inside repo");

        assert_eq!(
            layout_path,
            canonical_repo.join(".helm").join("graph-layouts.v1.json")
        );
        fs::remove_dir_all(repo_root).expect("test repo should be removed");
    }

    #[test]
    fn write_repo_graph_layouts_persists_with_atomic_helper() {
        let repo_root = unique_test_project_parent("layout-write");
        fs::create_dir_all(&repo_root).expect("test repo should be created");
        let canonical_repo = repo_root
            .canonicalize()
            .expect("test repo should canonicalize");
        let mut layouts = RepoGraphLayouts::default();
        let mut view = StoredGraphViewLayout::default();
        view.nodes.insert(
            "node:service".to_string(),
            StoredGraphNodePosition { x: 1.0, y: 2.0 },
        );
        layouts.views.insert("repo".to_string(), view);

        write_repo_graph_layouts(&canonical_repo, &layouts).expect("layout write should succeed");

        let layout_path = canonical_repo.join(".helm").join("graph-layouts.v1.json");
        assert!(layout_path.is_file());
        let decoded = read_repo_graph_layouts(&canonical_repo).expect("layout file should decode");
        assert_eq!(
            decoded
                .views
                .get("repo")
                .and_then(|view| view.nodes.get("node:service"))
                .map(|position| (position.x, position.y)),
            Some((1.0, 2.0))
        );
        let leftovers = fs::read_dir(
            layout_path
                .parent()
                .expect("layout path should have parent"),
        )
        .expect("layout parent should be readable")
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().contains("helm-tmp"))
        .count();
        assert_eq!(leftovers, 0);
        fs::remove_dir_all(repo_root).expect("test repo should be removed");
    }
}
