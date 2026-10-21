//! Passive run settings and filesystem-only tool resolution. No project hooks or .env loading.
use crate::atomic_file::atomic_write_text;
use crate::execution_policy::{ExecutionContext, ExecutionPolicy};
use crate::repo_boundary::{ensure_canonical_path_inside_repo, normalize_path, ActiveRepoBoundary};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewWindow};

const MAX_DOCUMENT: u64 = 256 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RunConfig {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) mode: String,
    pub(crate) executable: String,
    pub(crate) args: Vec<String>,
    pub(crate) command: String,
    pub(crate) cwd: String,
    pub(crate) env: BTreeMap<String, Option<String>>,
    pub(crate) secret_names: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RunConfigDocument {
    pub(crate) schema_version: u32,
    pub(crate) revision: u64,
    pub(crate) default_id: Option<String>,
    pub(crate) configs: Vec<RunConfig>,
}
impl Default for RunConfigDocument {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            default_id: None,
            configs: Vec::new(),
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredDocument {
    repo_path: String,
    document: RunConfigDocument,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolInfo {
    pub(crate) path: String,
    pub(crate) provenance: String,
    pub(crate) architecture: String,
    pub(crate) version: Option<String>,
    pub(crate) search_path_source: String,
}
// Intentionally does not implement Debug/Serialize: env can contain private values.
pub(crate) struct LaunchSpec {
    pub(crate) executable: PathBuf,
    pub(crate) args: Vec<String>,
    pub(crate) cwd: PathBuf,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) tool: ToolInfo,
    #[cfg(windows)]
    pub(crate) windows_shell_command: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunSuggestion {
    source: String,
    config: RunConfig,
}
#[derive(Default)]
pub(crate) struct RunConfigStore {
    lock: Mutex<()>,
}

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
}
pub(crate) fn validate_env_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 128
        || !name
            .bytes()
            .enumerate()
            .all(|(i, c)| c == b'_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
    {
        return Err("Environment names must use letters, digits and underscores and cannot start with a digit.".into());
    }
    let upper = name.to_ascii_uppercase();
    if upper.starts_with("HELM_")
        || matches!(
            upper.as_str(),
            "PYTHONHOME"
                | "PYTHONSTARTUP"
                | "NODE_OPTIONS"
                | "LD_PRELOAD"
                | "LD_LIBRARY_PATH"
                | "DYLD_INSERT_LIBRARIES"
                | "DYLD_LIBRARY_PATH"
        )
    {
        return Err("This environment name is reserved for runtime isolation.".into());
    }
    Ok(())
}
pub(crate) fn validate_config(config: &RunConfig) -> Result<(), String> {
    if !valid_id(&config.id)
        || config.name.trim().is_empty()
        || config.name.len() > 128
        || config.name.chars().any(char::is_control)
        || !matches!(config.kind.as_str(), "app" | "tests" | "build")
    {
        return Err(
            "Each configuration needs a stable ID, a name and App, Tests or Build kind.".into(),
        );
    }
    if !matches!(config.mode.as_str(), "executable" | "shell") {
        return Err("Select executable or explicit shell-command mode.".into());
    }
    if config.mode == "executable" && config.executable.trim().is_empty() {
        return Err("Choose a project executable or runtime.".into());
    }
    if config.mode == "shell" && (config.command.trim().is_empty()) {
        return Err("Shell mode requires a command.".into());
    }
    if config.args.len() > 256 || config.env.len() > 128 || config.secret_names.len() > 128 {
        return Err("Run configuration exceeds supported limits.".into());
    }
    if std::iter::once(&config.executable)
        .chain(std::iter::once(&config.command))
        .chain(std::iter::once(&config.cwd))
        .chain(config.args.iter())
        .any(|s| s.len() > 32768 || s.contains('\0'))
    {
        return Err("Run command, arguments or directory contains invalid data.".into());
    }
    if config.cwd.trim().is_empty() {
        return Err("Choose a working directory (use . for the project root).".into());
    }
    let mut seen = BTreeSet::new();
    for name in &config.secret_names {
        validate_env_name(name)?;
        if !seen.insert(name.to_ascii_uppercase())
            || config.env.keys().any(|k| k.eq_ignore_ascii_case(name))
        {
            return Err(
                "An environment key cannot have duplicate or both public and private values."
                    .into(),
            );
        }
    }
    for (name, value) in &config.env {
        validate_env_name(name)?;
        if !seen.insert(name.to_ascii_uppercase()) {
            return Err("Environment keys must be unique, including letter case.".into());
        }
        if value
            .as_ref()
            .is_some_and(|v| v.len() > 32768 || v.contains('\0'))
        {
            return Err("A nonsecret environment value is invalid or too large.".into());
        }
    }
    Ok(())
}
fn validate_document(document: &RunConfigDocument) -> Result<(), String> {
    if document.schema_version != 1 {
        return Err("Unsupported run-settings version. The saved file was preserved.".into());
    }
    if document.configs.len() > 64 {
        return Err("At most 64 run configurations are supported.".into());
    }
    let mut ids = BTreeSet::new();
    for config in &document.configs {
        validate_config(config)?;
        if !ids.insert(&config.id) {
            return Err("Run configuration IDs must be unique.".into());
        }
    }
    if document
        .default_id
        .as_ref()
        .is_some_and(|id| !ids.contains(id))
    {
        return Err("The selected default configuration does not exist.".into());
    }
    Ok(())
}
fn storage_path(directory: &Path, root: &Path) -> PathBuf {
    // Two independent stable hashes bound filename length. Stored identity is checked before reads/writes,
    // so even a collision fails closed instead of combining two checkouts.
    let text = normalize_path(root);
    let hash = |seed: u64| {
        text.bytes()
            .fold(seed, |h, c| (h ^ u64::from(c)).wrapping_mul(0x100000001b3))
    };
    directory.join("run-configs").join(format!(
        "{:016x}{:016x}.json",
        hash(0xcbf29ce484222325),
        hash(0x84222325cbf29ce4)
    ))
}
fn read_document(directory: &Path, root: &Path) -> Result<RunConfigDocument, String> {
    let path = storage_path(directory, root);
    if !path.exists() {
        return Ok(RunConfigDocument::default());
    }
    let metadata = fs::metadata(&path).map_err(|_| "Saved run settings could not be inspected.")?;
    if !metadata.is_file() || metadata.len() > MAX_DOCUMENT {
        return Err(
            "Saved run settings are oversized or not a file. Original preserved for repair.".into(),
        );
    }
    let raw = bounded_read(&path, MAX_DOCUMENT).map_err(|_| {
        "Saved run settings could not be read or exceed the limit. Original preserved."
    })?;
    let stored: StoredDocument = serde_json::from_slice(&raw).map_err(|_| {
        "Saved run settings are corrupt. Original preserved for repair; no command was selected."
    })?;
    if stored.repo_path != normalize_path(root) {
        return Err("Saved run settings identify a different checkout. Original preserved.".into());
    }
    validate_document(&stored.document)?;
    Ok(stored.document)
}
fn save_document(
    directory: &Path,
    root: &Path,
    mut document: RunConfigDocument,
) -> Result<RunConfigDocument, String> {
    validate_document(&document)?;
    let previous = read_document(directory, root)?;
    if previous.revision != document.revision {
        return Err("Run settings changed while editing. Reload settings before saving; your draft is preserved.".into());
    }
    document.revision = document
        .revision
        .checked_add(1)
        .ok_or("Run settings revision limit reached.")?;
    let stored = StoredDocument {
        repo_path: normalize_path(root),
        document: document.clone(),
    };
    let json =
        serde_json::to_string_pretty(&stored).map_err(|_| "Run settings could not be encoded.")?;
    if json.len() as u64 > MAX_DOCUMENT {
        return Err("Run settings exceed the supported file size.".into());
    }
    atomic_write_text(&storage_path(directory, root), &(json + "\n"))?;
    Ok(document)
}

/// Child environment is constructed from an allowlist, never inherited wholesale.
pub(crate) fn base_environment(
    inherited: impl IntoIterator<Item = (String, String)>,
) -> BTreeMap<String, String> {
    let allowed = [
        "PATH",
        "HOME",
        "USERPROFILE",
        "USERNAME",
        "USER",
        "LOGNAME",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "PROGRAMDATA",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TZ",
        "TERM",
        "COLORTERM",
        "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE",
        "OS",
    ];
    inherited
        .into_iter()
        .filter(|(key, _)| allowed.contains(&key.to_ascii_uppercase().as_str()))
        .collect()
}
fn env_get<'a>(env: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    env.iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.as_str())
}
fn env_remove(env: &mut BTreeMap<String, String>, key: &str) {
    let keys: Vec<_> = env
        .keys()
        .filter(|k| k.eq_ignore_ascii_case(key))
        .cloned()
        .collect();
    for k in keys {
        env.remove(&k);
    }
}
fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        true
    }
}
fn safe_runtime(invocation_path: PathBuf) -> Result<PathBuf, String> {
    let path = invocation_path.canonicalize().map_err(|_| {
        "The selected executable is unavailable. Select an installed project runtime."
    })?;
    if path.components().any(|c| {
        c.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case("helm-runtime")
    }) {
        return Err("HELM's bundled interpreter cannot be used as the project runtime. Select a separate installed Python or project venv.".into());
    }
    if !is_executable(&path) {
        return Err(
            "The selected tool is not an executable file. Choose an installed runtime or command."
                .into(),
        );
    }
    // Preserve the selected invocation path: resolving a venv Python symlink
    // before exec changes Python's sys.prefix and silently loses the venv.
    Ok(invocation_path)
}
/// Inspect headers without executing or importing project code. Script interpreters are
/// resolved separately by the OS; unknown headers are reported honestly.
fn tool_architecture(path: &Path) -> String {
    let Ok(mut file) = fs::File::open(path) else {
        return "unknown".into();
    };
    let mut header = [0u8; 64];
    let Ok(size) = file.read(&mut header) else {
        return "unknown".into();
    };
    let cpu = |value| match value {
        0x0100000c => "arm64",
        0x01000007 => "x86_64",
        7 => "x86",
        12 => "arm",
        _ => "unknown",
    };
    if size >= 8 && header[..4] == [0xcf, 0xfa, 0xed, 0xfe] {
        return cpu(u32::from_le_bytes(header[4..8].try_into().unwrap())).into();
    }
    if size >= 8 && header[..4] == [0xfe, 0xed, 0xfa, 0xcf] {
        return cpu(u32::from_be_bytes(header[4..8].try_into().unwrap())).into();
    }
    if size >= 8
        && matches!(
            &header[..4],
            [0xca, 0xfe, 0xba, 0xbe] | [0xca, 0xfe, 0xba, 0xbf]
        )
    {
        return "universal-macos".into();
    }
    if size >= 20 && header[..4] == [0x7f, b'E', b'L', b'F'] {
        let machine = if header[5] == 1 {
            u16::from_le_bytes([header[18], header[19]])
        } else {
            u16::from_be_bytes([header[18], header[19]])
        };
        return match machine {
            62 => "x86_64",
            183 => "arm64",
            3 => "x86",
            40 => "arm",
            _ => "unknown",
        }
        .into();
    }
    if size >= 64 && &header[..2] == b"MZ" {
        let offset = u32::from_le_bytes(header[60..64].try_into().unwrap());
        if offset > 1024 * 1024 || file.seek(SeekFrom::Start(u64::from(offset))).is_err() {
            return "unknown".into();
        }
        let mut pe = [0u8; 6];
        if file.read_exact(&mut pe).is_ok() && &pe[..4] == b"PE\0\0" {
            return match u16::from_le_bytes([pe[4], pe[5]]) {
                0x8664 => "x86_64",
                0xaa64 => "arm64",
                0x14c => "x86",
                _ => "unknown",
            }
            .into();
        }
    }
    if (size >= 2 && &header[..2] == b"#!")
        || path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
    {
        return "script (OS-selected interpreter)".into();
    }
    "unknown".into()
}
fn resolve_executable(
    root: &Path,
    cwd: &Path,
    selected: &str,
    env: &BTreeMap<String, String>,
) -> Result<(PathBuf, String), String> {
    let name = selected.trim();
    if name.is_empty() || name.contains('\0') {
        return Err("Choose an executable or project runtime.".into());
    }
    let path = Path::new(name);
    if path.is_absolute() || name.contains('/') || name.contains('\\') {
        return safe_runtime(if path.is_absolute() {
            path.to_path_buf()
        } else {
            cwd.join(path)
        })
        .map(|p| (p, "selected-path".into()));
    }
    if matches!(name, "python" | "python3" | "python.exe") {
        let mut candidates = BTreeSet::new();
        for location in [cwd, root] {
            for folder in [".venv", "venv"] {
                let candidate = if cfg!(windows) {
                    location.join(folder).join("Scripts/python.exe")
                } else {
                    location.join(folder).join("bin/python")
                };
                if candidate.exists() {
                    if !location.join(folder).join("pyvenv.cfg").is_file() {
                        return Err("A project virtual environment is incomplete (pyvenv.cfg is missing). Repair it manually or select an explicit interpreter path; no global fallback was chosen.".into());
                    }
                    candidates.insert(candidate);
                }
            }
        }
        if candidates.len() > 1 {
            return Err("Multiple project virtual environments were found. Select the intended Python executable by full path before running.".into());
        }
        if let Some(candidate) = candidates.into_iter().next() {
            return safe_runtime(candidate).map(|p| (p, "project-venv".into()));
        }
    }
    let search = env_get(env, "PATH").unwrap_or_default();
    let mut directories: Vec<PathBuf> = std::env::split_paths(search)
        .filter(|p| p.is_absolute())
        .collect();
    #[cfg(unix)]
    directories.extend(
        ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
            .iter()
            .map(PathBuf::from),
    );
    #[cfg(windows)]
    {
        if let Some(root) = env_get(env, "SYSTEMROOT") {
            directories.push(PathBuf::from(root).join("System32"));
        }
        if let Some(program) = env_get(env, "PROGRAMFILES") {
            directories.push(PathBuf::from(program).join("nodejs"));
        }
    }
    let extensions: Vec<String> = if cfg!(windows) && path.extension().is_none() {
        vec![".exe".into(), ".com".into(), ".cmd".into(), ".bat".into()]
    } else {
        vec![String::new()]
    };
    for directory in directories {
        // Ambient PATH entries in a checkout must not silently select project executables.
        if directory.canonicalize().is_ok_and(|p| p.starts_with(root)) {
            continue;
        }
        for extension in &extensions {
            let candidate = directory.join(format!("{}{}", name, extension));
            if is_executable(&candidate) {
                if let Ok(path) = safe_runtime(candidate) {
                    return Ok((path, "system-search".into()));
                }
            }
        }
    }
    Err(format!("Project tool '{}' was not found. Select its full executable path, create/select a project venv, or install the tool manually and restart HELM to refresh GUI PATH. No dependency was installed.", name))
}
pub(crate) fn prepare_launch(
    root: &Path,
    config: &RunConfig,
    secrets: &BTreeMap<String, String>,
) -> Result<LaunchSpec, String> {
    validate_config(config)?;
    let requested_cwd = Path::new(&config.cwd);
    let cwd = if requested_cwd.is_absolute() {
        requested_cwd.to_path_buf()
    } else {
        root.join(requested_cwd)
    }
    .canonicalize()
    .map_err(|_| {
        "Run working directory is missing. Edit cwd or choose an existing project folder."
    })?;
    ensure_canonical_path_inside_repo(&cwd, root, "Run working directory")?;
    if !cwd.is_dir() {
        return Err("Run working directory must be a folder.".into());
    }
    let mut env = base_environment(
        std::env::vars_os()
            .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))),
    );
    for (name, value) in &config.env {
        env_remove(&mut env, name);
        if let Some(value) = value {
            env.insert(name.clone(), value.clone());
        }
    }
    for name in &config.secret_names {
        let value = secrets.iter().find(|(key,_)| key.eq_ignore_ascii_case(name)).map(|(_,value)|value).ok_or("A required private environment value is missing. Set the configuration's session values before running.")?;
        env_remove(&mut env, name);
        env.insert(name.clone(), value.clone());
    }
    let (selected, args, provenance) = if config.mode == "shell" {
        #[cfg(windows)]
        let default_shell = std::env::var_os("SYSTEMROOT")
            .map(PathBuf::from)
            .ok_or("Windows system directory is unavailable. Select a native executable instead.")?
            .join("System32/cmd.exe")
            .to_string_lossy()
            .into_owned();
        #[cfg(not(windows))]
        let default_shell = "/bin/sh".to_string();
        let selected = default_shell; // Inactive executable/argv fields remain editable drafts, never shell selection.
        #[cfg(windows)]
        let args = vec![
            "/D".into(),
            "/S".into(),
            "/C".into(),
            config.command.clone(),
        ];
        #[cfg(not(windows))]
        let args = vec!["-c".into(), config.command.clone()];
        (selected, args, Some("system-shell"))
    } else {
        (config.executable.clone(), config.args.clone(), None)
    };
    let (executable, found_via) = resolve_executable(root, &cwd, &selected, &env)?;
    // Selecting a venv affects this child's environment only. Do not canonicalize
    // away the venv launcher path; Python discovers pyvenv.cfg relative to it.
    if let Some(bin) = executable.parent() {
        if let Some(venv) = bin.parent().filter(|p| p.join("pyvenv.cfg").is_file()) {
            let mut paths = vec![bin.to_path_buf()];
            paths.extend(std::env::split_paths(
                env_get(&env, "PATH").unwrap_or_default(),
            ));
            if let Ok(path) = std::env::join_paths(paths) {
                env_remove(&mut env, "PATH");
                env.insert("PATH".into(), path.to_string_lossy().into());
            }
            env.insert("VIRTUAL_ENV".into(), normalize_path(venv));
        }
    }
    // Never inject HELM's worker PYTHONPATH, loader controls or service/provider tokens.
    let tool = ToolInfo {
        path: normalize_path(&executable),
        provenance: provenance.unwrap_or(&found_via).into(),
        architecture: tool_architecture(&executable),
        version: None,
        search_path_source: "GUI PATH plus documented system directories; no shell hooks".into(),
    };
    #[cfg(windows)]
    let (executable, args, windows_shell_command) = {
        if config.mode == "shell" {
            (executable, Vec::new(), Some(config.command.clone()))
        } else if executable
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
        {
            let text = executable
                .to_str()
                .ok_or("The selected wrapper path is not valid Unicode.")?;
            let invalid = |s: &str| s.chars().any(|c| "%!^&|<>\r\n\"".contains(c));
            if invalid(text) || args.iter().any(|a| invalid(a) || a.ends_with('\\')) {
                return Err("Windows command wrappers require literal arguments without shell metacharacters, embedded quotes or trailing backslashes. Select the underlying native executable for exact argv, or use explicit System shell mode for intended shell syntax.".into());
            }
            let command = std::iter::once(text)
                .chain(args.iter().map(String::as_str))
                .map(|s| format!("\"{}\"", s))
                .collect::<Vec<_>>()
                .join(" ");
            let system = std::env::var_os("SYSTEMROOT")
                .ok_or("Windows system directory is unavailable; select a native executable.")?;
            let cmd = safe_runtime(PathBuf::from(system).join("System32/cmd.exe"))?;
            (cmd, Vec::new(), Some(command))
        } else {
            (executable, args, None)
        }
    };
    Ok(LaunchSpec {
        executable,
        args,
        cwd,
        env,
        tool,
        #[cfg(windows)]
        windows_shell_command,
    })
}
fn bounded_read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|_| "File could not be opened.")?;
    let mut data = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut data)
        .map_err(|_| "File could not be read.")?;
    if data.len() as u64 > limit {
        return Err("File exceeds the supported size.".into());
    }
    Ok(data)
}
fn bounded_manifest(root: &Path, relative: &str) -> Result<Option<String>, String> {
    let candidate = root.join(relative);
    if !candidate.exists() {
        return Ok(None);
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|_| "Manifest could not be resolved.")?;
    ensure_canonical_path_inside_repo(&canonical, root, "Manifest")?;
    if fs::metadata(&canonical)
        .map_err(|_| "Manifest could not be inspected.")?
        .len()
        > MAX_DOCUMENT
    {
        return Err(format!(
            "{} is too large for passive suggestions. Add a manual configuration.",
            relative
        ));
    }
    String::from_utf8(bounded_read(&canonical, MAX_DOCUMENT)?)
        .map(Some)
        .map_err(|_| "Manifest is unreadable. Add a manual configuration.".into())
}
fn suggestion(
    id: String,
    name: String,
    kind: &str,
    executable: &str,
    args: Vec<String>,
    source: &str,
) -> RunSuggestion {
    RunSuggestion {
        source: source.into(),
        config: RunConfig {
            id,
            name,
            kind: kind.into(),
            mode: "executable".into(),
            executable: executable.into(),
            args,
            command: String::new(),
            cwd: ".".into(),
            env: BTreeMap::new(),
            secret_names: Vec::new(),
        },
    }
}
fn suggestions(root: &Path) -> Result<Vec<RunSuggestion>, String> {
    let mut result = Vec::new();
    if let Some(raw) = bounded_manifest(root, "package.json")? {
        let manifest: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|_| "package.json is malformed. Add a manual configuration.")?;
        if let Some(scripts) = manifest.get("scripts").and_then(|v| v.as_object()) {
            for (name, command) in scripts.iter().take(32) {
                if name.len() > 128 || !command.is_string() {
                    continue;
                }
                let kind = if name == "test" {
                    "tests"
                } else if name == "build" {
                    "build"
                } else {
                    "app"
                };
                result.push(suggestion(
                    format!("npm-{}", result.len()),
                    format!("npm: {}", name),
                    kind,
                    "npm",
                    vec!["run".into(), name.clone()],
                    "package.json scripts (review before saving)",
                ));
            }
        }
    }
    if let Some(raw) = bounded_manifest(root, "pyproject.toml")? {
        let manifest: toml::Value = toml::from_str(&raw)
            .map_err(|_| "pyproject.toml is malformed. Add a manual configuration.")?;
        if let Some(scripts) = manifest
            .get("project")
            .and_then(|v| v.get("scripts"))
            .and_then(|v| v.as_table())
        {
            for (name, entry) in scripts.iter().take(32) {
                if name.len() > 128 || !valid_id(name) || !entry.is_str() {
                    continue;
                }
                result.push(suggestion(
                    format!("python-{}", result.len()),
                    format!("Python entrypoint: {}", name),
                    "app",
                    name,
                    Vec::new(),
                    "pyproject.toml project.scripts (requires installed project entrypoint)",
                ));
            }
        }
    }
    Ok(result)
}
fn command_root(
    window: &WebviewWindow,
    policy: &ExecutionPolicy,
    active_repo: &ActiveRepoBoundary,
    context: &ExecutionContext,
) -> Result<PathBuf, String> {
    let root = policy.validate_owner(window.label(), context)?;
    active_repo.command_repo_root(&normalize_path(&root))
}
#[tauri::command]
pub(crate) fn execution_read_configs(
    app: AppHandle,
    window: WebviewWindow,
    policy: State<'_, ExecutionPolicy>,
    active_repo: State<'_, ActiveRepoBoundary>,
    store: State<'_, RunConfigStore>,
    context: ExecutionContext,
) -> Result<RunConfigDocument, String> {
    let _work = crate::maintenance::work()?;
    let root = command_root(&window, &policy, &active_repo, &context)?;
    let _lock = store
        .lock
        .lock()
        .map_err(|_| "Run settings state unavailable.")?;
    read_document(
        &app.path()
            .app_data_dir()
            .map_err(|_| "Application data directory unavailable.")?,
        &root,
    )
}
#[tauri::command]
pub(crate) fn execution_save_configs(
    app: AppHandle,
    window: WebviewWindow,
    policy: State<'_, ExecutionPolicy>,
    active_repo: State<'_, ActiveRepoBoundary>,
    store: State<'_, RunConfigStore>,
    context: ExecutionContext,
    document: RunConfigDocument,
) -> Result<RunConfigDocument, String> {
    let _work = crate::maintenance::work()?;
    let root = command_root(&window, &policy, &active_repo, &context)?;
    let _lock = store
        .lock
        .lock()
        .map_err(|_| "Run settings state unavailable.")?;
    save_document(
        &app.path()
            .app_data_dir()
            .map_err(|_| "Application data directory unavailable.")?,
        &root,
        document,
    )
}
#[tauri::command]
pub(crate) fn execution_suggestions(
    window: WebviewWindow,
    policy: State<'_, ExecutionPolicy>,
    active_repo: State<'_, ActiveRepoBoundary>,
    context: ExecutionContext,
) -> Result<Vec<RunSuggestion>, String> {
    let _work = crate::maintenance::work()?;
    suggestions(&command_root(&window, &policy, &active_repo, &context)?)
}
#[tauri::command]
pub(crate) fn execution_resolve_tool(
    window: WebviewWindow,
    policy: State<'_, ExecutionPolicy>,
    active_repo: State<'_, ActiveRepoBoundary>,
    context: ExecutionContext,
    config: RunConfig,
) -> Result<ToolInfo, String> {
    let _work = crate::maintenance::work()?;
    command_root(&window, &policy, &active_repo, &context)?;
    policy
        .launch_spec(window.label(), &context, &config)
        .map(|spec| spec.tool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "helm-run-config-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&p).unwrap();
            // macOS temp paths can use /var while canonical containment uses
            // /private/var. Match the production native boundary's canonical root.
            Self(p.canonicalize().unwrap())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn config() -> RunConfig {
        RunConfig {
            id: "app".into(),
            name: "App".into(),
            kind: "app".into(),
            mode: "executable".into(),
            executable: if cfg!(windows) { "cmd.exe" } else { "/bin/sh" }.into(),
            args: Vec::new(),
            command: String::new(),
            cwd: ".".into(),
            env: BTreeMap::new(),
            secret_names: Vec::new(),
        }
    }
    #[test]
    fn round_trip_and_compare_revision_without_overwriting_corrupt_file() {
        let f = Fixture::new();
        let root = f.0.canonicalize().unwrap();
        let d = RunConfigDocument {
            configs: vec![config()],
            default_id: Some("app".into()),
            ..RunConfigDocument::default()
        };
        let saved = save_document(&f.0, &root, d.clone()).unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(
            read_document(&f.0, &root).unwrap().default_id.as_deref(),
            Some("app")
        );
        assert!(save_document(&f.0, &root, d).is_err());
        let file = storage_path(&f.0, &root);
        fs::write(&file, b"broken!").unwrap();
        assert!(read_document(&f.0, &root).is_err());
        assert!(save_document(&f.0, &root, saved).is_err());
        assert_eq!(fs::read(file).unwrap(), b"broken!");
    }
    #[test]
    fn invalid_schema_default_and_duplicate_ids_fail_atomically() {
        let mut d = RunConfigDocument {
            schema_version: 2,
            ..RunConfigDocument::default()
        };
        assert!(validate_document(&d).is_err());
        d.schema_version = 1;
        d.default_id = Some("gone".into());
        assert!(validate_document(&d).is_err());
        d.default_id = None;
        d.configs = vec![config(), config()];
        assert!(validate_document(&d).is_err());
        d.configs[1].id = "different".into();
        assert!(validate_document(&d).is_ok()); // duplicate names are allowed
    }
    #[test]
    fn environment_canaries_never_inherit_and_selected_secrets_are_required() {
        let env = base_environment([
            ("PATH".into(), "/bin".into()),
            ("HELM_ISSUES_TOKEN".into(), "synthetic-issue".into()),
            ("OPENAI_API_KEY".into(), "synthetic-provider".into()),
            ("PYTHONPATH".into(), "backend-path".into()),
            ("OTHER_SECRET".into(), "synthetic-other".into()),
        ]);
        assert_eq!(env.len(), 1);
        assert_eq!(env.get("PATH").unwrap(), "/bin");
        let f = Fixture::new();
        let root = f.0.canonicalize().unwrap();
        let mut c = config();
        c.secret_names.push("PROJECT_TOKEN".into());
        assert!(prepare_launch(&root, &c, &BTreeMap::new()).is_err());
        let spec = prepare_launch(
            &root,
            &c,
            &BTreeMap::from([
                ("PROJECT_TOKEN".into(), "synthetic-selected".into()),
                ("UNRELATED".into(), "never-child".into()),
            ]),
        )
        .unwrap();
        assert_eq!(spec.env.get("PROJECT_TOKEN").unwrap(), "synthetic-selected");
        assert!(!spec.env.contains_key("UNRELATED"));
        assert!(!serde_json::to_string(&c)
            .unwrap()
            .contains("synthetic-selected"));
    }
    #[test]
    fn cwd_and_reserved_environment_are_validated() {
        let f = Fixture::new();
        let root = f.0.canonicalize().unwrap();
        let mut c = config();
        c.cwd = "..".into();
        assert!(prepare_launch(&root, &c, &BTreeMap::new()).is_err());
        c.cwd = ".".into();
        c.env.insert("HELM_TOKEN".into(), Some("synthetic".into()));
        assert!(validate_config(&c).is_err());
        c.env.clear();
        c.env.insert("Foo".into(), None);
        c.env.insert("FOO".into(), None);
        assert!(validate_config(&c).is_err());
    }
    #[test]
    fn passive_manifest_suggestions_cannot_run_scripts_or_load_env() {
        let f = Fixture::new();
        fs::write(
            f.0.join("package.json"),
            r#"{"scripts":{"start":"touch MUST_NOT_EXIST","test":"some-test"}}"#,
        )
        .unwrap();
        fs::write(
            f.0.join("pyproject.toml"),
            "[project.scripts]\nhello = 'example.main:main'\n",
        )
        .unwrap();
        fs::write(f.0.join(".env"), "HELLO=should-not-load").unwrap();
        let s = suggestions(&f.0).unwrap();
        assert_eq!(s.len(), 3);
        assert!(!f.0.join("MUST_NOT_EXIST").exists());
        assert!(s.iter().all(|s| s.config.env.is_empty()));
        fs::write(f.0.join("package.json"), "not-json").unwrap();
        assert!(suggestions(&f.0).is_err());
        #[cfg(unix)]
        {
            let outside = Fixture::new();
            fs::write(
                outside.0.join("package.json"),
                r#"{"scripts":{"start":"touch MUST_NOT_EXIST"}}"#,
            )
            .unwrap();
            fs::remove_file(f.0.join("package.json")).unwrap();
            std::os::unix::fs::symlink(outside.0.join("package.json"), f.0.join("package.json"))
                .unwrap();
            let error = suggestions(&f.0).err().unwrap();
            assert!(error.contains("Manifest must stay inside"));
            assert!(!outside.0.join("MUST_NOT_EXIST").exists());
        }
    }
    #[test]
    fn binary_headers_and_size_limits_are_inspected_without_execution() {
        let f = Fixture::new();
        let binary = f.0.join("tool");
        let mut bytes = vec![0; 64];
        bytes[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
        bytes[4..8].copy_from_slice(&0x0100000cu32.to_le_bytes());
        fs::write(&binary, &bytes).unwrap();
        assert_eq!(tool_architecture(&binary), "arm64");
        bytes[..4].copy_from_slice(&[0x7f, b'E', b'L', b'F']);
        bytes[5] = 1;
        bytes[18..20].copy_from_slice(&62u16.to_le_bytes());
        fs::write(&binary, &bytes).unwrap();
        assert_eq!(tool_architecture(&binary), "x86_64");
        fs::write(&binary, b"#!/bin/sh\nexit 0").unwrap();
        assert!(tool_architecture(&binary).starts_with("script"));
        assert!(bounded_read(&binary, 2).is_err());
    }
    #[test]
    fn shell_mode_is_explicit_and_preserves_inactive_executable_fields() {
        let f = Fixture::new();
        let root = f.0.canonicalize().unwrap();
        let mut c = config();
        c.mode = "shell".into();
        c.command = "printf literal".into();
        c.executable = "not-selected-in-shell-mode".into();
        c.args = vec!["inactive".into()];
        let spec = prepare_launch(&root, &c, &BTreeMap::new()).unwrap();
        assert!(spec
            .executable
            .file_name()
            .is_some_and(|s| s == "sh" || s == "cmd.exe"));
        #[cfg(unix)]
        assert_eq!(spec.args, vec!["-c", "printf literal"]);
        #[cfg(windows)]
        assert_eq!(
            spec.windows_shell_command.as_deref(),
            Some("printf literal")
        );
    }
    #[test]
    fn two_checkouts_have_separate_settings_and_no_implicit_default() {
        let f = Fixture::new();
        let first = f.0.join("first Ω");
        let second = f.0.join("second Ω");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        let mut d = RunConfigDocument::default();
        d.configs.push(config());
        save_document(&f.0, &first, d).unwrap();
        assert!(read_document(&f.0, &second).unwrap().configs.is_empty());
        assert_eq!(read_document(&f.0, &first).unwrap().default_id, None);
    }
    #[test]
    fn named_configs_round_trip_duplicate_names_stable_ids_and_literal_windows_argv() {
        let f = Fixture::new();
        let mut configs = Vec::new();
        for (id, kind) in [("app", "app"), ("test", "tests"), ("build", "build")] {
            let mut c = config();
            c.id = id.into();
            c.kind = kind.into();
            c.name = "Same display name".into();
            c.args = vec![
                "C:\\project Ω\\main.py".into(),
                "two words".into(),
                "tail\\".into(),
                "\"quoted\"".into(),
            ];
            configs.push(c);
        }
        let d = RunConfigDocument {
            configs,
            default_id: Some("test".into()),
            ..Default::default()
        };
        let saved = save_document(&f.0, &f.0, d).unwrap();
        assert_eq!(
            serde_json::to_value(read_document(&f.0, &f.0).unwrap()).unwrap(),
            serde_json::to_value(&saved).unwrap()
        );
        assert_eq!(
            saved
                .configs
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            vec!["app", "test", "build"]
        );
        // These are storage/argv data assertions, not a Windows process-launch claim.
        assert_eq!(saved.configs[0].args[0], "C:\\project Ω\\main.py");
        assert_eq!(saved.default_id.as_deref(), Some("test"));
    }
    #[test]
    fn invalid_default_and_unsupported_or_truncated_storage_never_replace_valid_record() {
        let f = Fixture::new();
        let saved = save_document(
            &f.0,
            &f.0,
            RunConfigDocument {
                configs: vec![config()],
                default_id: Some("app".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let path = storage_path(&f.0, &f.0);
        let valid = fs::read(&path).unwrap();
        let mut removed = saved.clone();
        removed.configs.clear();
        assert!(save_document(&f.0, &f.0, removed)
            .unwrap_err()
            .contains("default"));
        assert_eq!(fs::read(&path).unwrap(), valid);
        let mut unsupported: serde_json::Value = serde_json::from_slice(&valid).unwrap();
        unsupported["document"]["schemaVersion"] = 999.into();
        for bytes in [
            serde_json::to_vec(&unsupported).unwrap(),
            valid[..valid.len() / 2].to_vec(),
        ] {
            fs::write(&path, &bytes).unwrap();
            assert!(read_document(&f.0, &f.0).is_err());
            assert!(save_document(&f.0, &f.0, saved.clone()).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }
    #[cfg(unix)]
    #[test]
    fn read_only_settings_directory_refuses_write_and_preserves_last_record() {
        use std::os::unix::fs::PermissionsExt;
        struct Restore(PathBuf, fs::Permissions);
        impl Drop for Restore {
            fn drop(&mut self) {
                fs::set_permissions(&self.0, self.1.clone()).unwrap();
            }
        }
        let f = Fixture::new();
        let mut saved = save_document(
            &f.0,
            &f.0,
            RunConfigDocument {
                configs: vec![config()],
                ..Default::default()
            },
        )
        .unwrap();
        let path = storage_path(&f.0, &f.0);
        let bytes = fs::read(&path).unwrap();
        let directory = path.parent().unwrap();
        let restore = Restore(
            directory.into(),
            fs::metadata(directory).unwrap().permissions(),
        );
        fs::set_permissions(directory, fs::Permissions::from_mode(0o500)).unwrap();
        saved.configs[0].name = "Unsaved replacement".into();
        assert!(save_document(&f.0, &f.0, saved).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        drop(restore);
        assert_eq!(fs::read_dir(directory).unwrap().count(), 1);
    }
    #[test]
    fn cwd_relative_absolute_unicode_and_moved_directory_are_resolved_without_launch() {
        let f = Fixture::new();
        let cwd = f.0.join("sub folder Ω");
        fs::create_dir(&cwd).unwrap();
        let mut c = config();
        c.cwd = "sub folder Ω".into();
        let relative = prepare_launch(&f.0, &c, &BTreeMap::new()).unwrap();
        c.cwd = cwd.to_string_lossy().into();
        assert_eq!(
            prepare_launch(&f.0, &c, &BTreeMap::new()).unwrap().cwd,
            relative.cwd
        );
        fs::rename(&cwd, f.0.join("moved")).unwrap();
        let error = prepare_launch(&f.0, &c, &BTreeMap::new()).err().unwrap();
        assert!(error.contains("Edit cwd"));
    }
    #[test]
    fn prepared_launch_snapshot_is_immutable_and_future_preparation_uses_new_config() {
        let f = Fixture::new();
        let mut c = config();
        c.args = vec!["initial literal".into()];
        c.env.insert("FIXTURE_MODE".into(), Some("initial".into()));
        let first = prepare_launch(&f.0, &c, &BTreeMap::new()).unwrap();
        c.args[0] = "next literal".into();
        c.env.insert("FIXTURE_MODE".into(), Some("next".into()));
        let next = prepare_launch(&f.0, &c, &BTreeMap::new()).unwrap();
        assert_eq!(first.args, vec!["initial literal"]);
        assert_eq!(first.env["FIXTURE_MODE"], "initial");
        assert_eq!(next.args, vec!["next literal"]);
        assert_eq!(next.env["FIXTURE_MODE"], "next");
    }
    #[cfg(unix)]
    #[test]
    fn venv_invocation_path_is_preserved_and_ambiguity_requires_selection() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let root = f.0.canonicalize().unwrap();
        let bin = root.join(".venv/bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(root.join(".venv/pyvenv.cfg"), "home = fixture").unwrap();
        symlink("/bin/sh", bin.join("python")).unwrap();
        let mut c = config();
        c.executable = "python".into();
        let spec = prepare_launch(&root, &c, &BTreeMap::new()).unwrap();
        assert_eq!(spec.executable, bin.join("python"));
        assert_eq!(spec.tool.provenance, "project-venv");
        assert_eq!(
            spec.env.get("VIRTUAL_ENV").unwrap(),
            &normalize_path(&root.join(".venv"))
        );
        let second = root.join("venv/bin");
        fs::create_dir_all(&second).unwrap();
        symlink("/bin/sh", second.join("python")).unwrap();
        fs::write(root.join("venv/pyvenv.cfg"), "home = second fixture").unwrap();
        assert!(prepare_launch(&root, &c, &BTreeMap::new())
            .err()
            .unwrap()
            .contains("Multiple project virtual environments"));
        c.executable = bin.join("python").to_string_lossy().into_owned();
        assert_eq!(
            prepare_launch(&root, &c, &BTreeMap::new())
                .unwrap()
                .executable,
            bin.join("python")
        );
    }
    #[cfg(unix)]
    #[test]
    fn missing_tool_and_symlink_escape_are_refused_without_spawning() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let root = f.0.canonicalize().unwrap();
        let mut c = config();
        c.executable = "helm-fixture-no-such-tool-092183".into();
        let error = prepare_launch(&root, &c, &BTreeMap::new()).err().unwrap();
        assert!(error.contains("No dependency was installed"));
        symlink("/", root.join("outside")).unwrap();
        c = config();
        c.cwd = "outside".into();
        assert!(prepare_launch(&root, &c, &BTreeMap::new()).is_err());
    }
}
