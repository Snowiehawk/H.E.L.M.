use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::menu::CheckMenuItem;
#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
#[cfg(target_os = "macos")]
use tauri::AppHandle;
use tauri::Wry;

pub(crate) const MENU_ID_SHOW_CALLS: &str = "graph-view.show-calls";
pub(crate) const MENU_ID_SHOW_IMPORTS: &str = "graph-view.show-imports";
pub(crate) const MENU_ID_SHOW_DEFINES: &str = "graph-view.show-defines";
pub(crate) const MENU_ID_HIGHLIGHT_PATH: &str = "graph-view.highlight-path";
pub(crate) const MENU_ID_SHOW_EDGE_LABELS: &str = "graph-view.show-edge-labels";
pub(crate) const MENU_ID_NEW_PROJECT: &str = "app.new-project";
pub(crate) const MENU_ID_UNDO: &str = "app.undo";
pub(crate) const MENU_ID_REDO: &str = "app.redo";
pub(crate) const MENU_ID_PREFERENCES: &str = "app.preferences";
pub(crate) const MENU_ID_ZOOM_IN: &str = "app.zoom-in";
pub(crate) const MENU_ID_ZOOM_OUT: &str = "app.zoom-out";
pub(crate) const MENU_ID_ZOOM_RESET: &str = "app.zoom-reset";

#[derive(Default)]
pub(crate) struct GraphViewMenuState {
    show_calls: Mutex<Option<CheckMenuItem<Wry>>>,
    show_imports: Mutex<Option<CheckMenuItem<Wry>>>,
    show_defines: Mutex<Option<CheckMenuItem<Wry>>>,
    highlight_path: Mutex<Option<CheckMenuItem<Wry>>>,
    show_edge_labels: Mutex<Option<CheckMenuItem<Wry>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphViewMenuActionPayload {
    pub(crate) action: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphViewMenuSyncPayload {
    include_calls: bool,
    include_imports: bool,
    include_defines: bool,
    highlight_graph_path: bool,
    show_edge_labels: bool,
}

fn set_graph_view_menu_item(
    item: &Mutex<Option<CheckMenuItem<Wry>>>,
    checked: bool,
) -> Result<(), String> {
    let handle = item
        .lock()
        .map_err(|_| "Unable to lock graph view menu state.".to_string())?;

    if let Some(item) = handle.as_ref() {
        item.set_checked(checked)
            .map_err(|err| format!("Unable to update graph view menu item: {}", err))?;
    }

    Ok(())
}

fn sync_graph_view_menu_items(
    state: &GraphViewMenuState,
    payload: &GraphViewMenuSyncPayload,
) -> Result<(), String> {
    set_graph_view_menu_item(&state.show_calls, payload.include_calls)?;
    set_graph_view_menu_item(&state.show_imports, payload.include_imports)?;
    set_graph_view_menu_item(&state.show_defines, payload.include_defines)?;
    set_graph_view_menu_item(&state.highlight_path, payload.highlight_graph_path)?;
    set_graph_view_menu_item(&state.show_edge_labels, payload.show_edge_labels)?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn build_macos_app_menu(
    app: &AppHandle<Wry>,
    state: &GraphViewMenuState,
) -> tauri::Result<Menu<Wry>> {
    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };

    let show_calls = CheckMenuItem::with_id(
        app,
        MENU_ID_SHOW_CALLS,
        "Show Calls",
        true,
        true,
        None::<&str>,
    )?;
    let show_imports = CheckMenuItem::with_id(
        app,
        MENU_ID_SHOW_IMPORTS,
        "Show Imports",
        true,
        true,
        None::<&str>,
    )?;
    let show_defines = CheckMenuItem::with_id(
        app,
        MENU_ID_SHOW_DEFINES,
        "Show Defines",
        true,
        true,
        None::<&str>,
    )?;
    let highlight_path = CheckMenuItem::with_id(
        app,
        MENU_ID_HIGHLIGHT_PATH,
        "Highlight Current Path",
        true,
        true,
        None::<&str>,
    )?;
    let show_edge_labels = CheckMenuItem::with_id(
        app,
        MENU_ID_SHOW_EDGE_LABELS,
        "Show Edge Labels",
        true,
        true,
        None::<&str>,
    )?;
    let zoom_in = MenuItem::with_id(
        app,
        MENU_ID_ZOOM_IN,
        "Zoom In",
        true,
        Some("CmdOrCtrl+Shift+="),
    )?;
    let undo = MenuItem::with_id(app, MENU_ID_UNDO, "Undo", true, Some("CmdOrCtrl+Z"))?;
    let redo = MenuItem::with_id(app, MENU_ID_REDO, "Redo", true, Some("CmdOrCtrl+Shift+Z"))?;
    let preferences = MenuItem::with_id(
        app,
        MENU_ID_PREFERENCES,
        "Preferences...",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let zoom_out = MenuItem::with_id(app, MENU_ID_ZOOM_OUT, "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let zoom_reset = MenuItem::with_id(
        app,
        MENU_ID_ZOOM_RESET,
        "Actual Size",
        true,
        Some("CmdOrCtrl+0"),
    )?;
    let new_project = MenuItem::with_id(
        app,
        MENU_ID_NEW_PROJECT,
        "New Project...",
        true,
        Some("CmdOrCtrl+Shift+N"),
    )?;

    if let Ok(mut item) = state.show_calls.lock() {
        *item = Some(show_calls.clone());
    }
    if let Ok(mut item) = state.show_imports.lock() {
        *item = Some(show_imports.clone());
    }
    if let Ok(mut item) = state.show_defines.lock() {
        *item = Some(show_defines.clone());
    }
    if let Ok(mut item) = state.highlight_path.lock() {
        *item = Some(highlight_path.clone());
    }
    if let Ok(mut item) = state.show_edge_labels.lock() {
        *item = Some(show_edge_labels.clone());
    }

    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                pkg_info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
                    &PredefinedMenuItem::separator(app)?,
                    &preferences,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &new_project,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &undo,
                    &redo,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &zoom_in,
                    &zoom_out,
                    &zoom_reset,
                    &PredefinedMenuItem::separator(app)?,
                    &show_calls,
                    &show_imports,
                    &show_defines,
                    &PredefinedMenuItem::separator(app)?,
                    &highlight_path,
                    &show_edge_labels,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::fullscreen(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "Help", true, &[])?,
        ],
    )
}

pub(crate) fn sync_graph_view_menu_state(
    state: &GraphViewMenuState,
    state_json: &str,
) -> Result<(), String> {
    let payload: GraphViewMenuSyncPayload = serde_json::from_str(state_json)
        .map_err(|err| format!("Unable to decode graph view menu state: {}", err))?;

    sync_graph_view_menu_items(state, &payload)
}

pub(crate) fn menu_action_for_id(id: &str) -> Option<&'static str> {
    match id {
        MENU_ID_NEW_PROJECT => Some("new-project"),
        MENU_ID_UNDO => Some("undo"),
        MENU_ID_REDO => Some("redo"),
        MENU_ID_PREFERENCES => Some("preferences"),
        MENU_ID_ZOOM_IN => Some("zoom-in"),
        MENU_ID_ZOOM_OUT => Some("zoom-out"),
        MENU_ID_ZOOM_RESET => Some("zoom-reset"),
        MENU_ID_SHOW_CALLS => Some("toggle-calls"),
        MENU_ID_SHOW_IMPORTS => Some("toggle-imports"),
        MENU_ID_SHOW_DEFINES => Some("toggle-defines"),
        MENU_ID_HIGHLIGHT_PATH => Some("toggle-path-highlight"),
        MENU_ID_SHOW_EDGE_LABELS => Some("toggle-edge-labels"),
        _ => None,
    }
}
