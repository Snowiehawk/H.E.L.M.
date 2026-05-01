use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug)]
pub(crate) struct ResolvedRepoPath {
    pub(crate) relative_path: String,
    pub(crate) target_path: PathBuf,
}

#[derive(Default)]
pub(crate) struct ActiveRepoBoundary {
    repo_root: Mutex<Option<PathBuf>>,
}

impl ActiveRepoBoundary {
    pub(crate) fn set_active_repo(&self, repo_root: PathBuf) -> Result<(), String> {
        let mut active = self
            .repo_root
            .lock()
            .map_err(|_| "Unable to lock the active repository state.".to_string())?;
        *active = Some(repo_root);
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn activate_repo_path(&self, repo_path: &str) -> Result<PathBuf, String> {
        let repo_root = canonicalize_repo_root(repo_path)?;
        self.set_active_repo(repo_root.clone())?;
        Ok(repo_root)
    }

    pub(crate) fn command_repo_root(&self, repo_path: &str) -> Result<PathBuf, String> {
        let renderer_repo_root = canonicalize_repo_root(repo_path)?;
        let active_repo_root = self
            .repo_root
            .lock()
            .map_err(|_| "Unable to lock the active repository state.".to_string())?
            .clone()
            .ok_or_else(|| {
                "No active repository is available. Open or reindex a repository first.".to_string()
            })?;

        if renderer_repo_root != active_repo_root {
            return Err(
                "Repository path does not match the active repository. Reopen or reindex the repository."
                    .to_string(),
            );
        }

        Ok(active_repo_root)
    }

    pub(crate) fn command_repo_path(&self, repo_path: &str) -> Result<String, String> {
        self.command_repo_root(repo_path)
            .map(|repo_root| normalize_path(&repo_root))
    }

    pub(crate) fn resolve_existing_target(
        &self,
        repo_path: &str,
        relative_path: &str,
    ) -> Result<ResolvedRepoPath, String> {
        let repo_root = self.command_repo_root(repo_path)?;
        let relative_path = normalize_repo_relative_path(relative_path)?;
        let candidate = repo_root.join(Path::new(&relative_path));
        let target_path = candidate.canonicalize().map_err(|err| {
            format!(
                "Unable to resolve repo-relative path {}: {}",
                relative_path, err
            )
        })?;
        ensure_canonical_path_inside_repo(&target_path, &repo_root, "Repo-relative path")?;
        Ok(ResolvedRepoPath {
            relative_path,
            target_path,
        })
    }

    pub(crate) fn resolve_creatable_target(
        &self,
        repo_path: &str,
        relative_path: &str,
    ) -> Result<ResolvedRepoPath, String> {
        let repo_root = self.command_repo_root(repo_path)?;
        let relative_path = normalize_repo_relative_path(relative_path)?;
        let target_path = repo_root.join(Path::new(&relative_path));
        if target_path.exists() {
            let canonical_target = target_path.canonicalize().map_err(|err| {
                format!(
                    "Unable to resolve repo-relative path {}: {}",
                    relative_path, err
                )
            })?;
            ensure_canonical_path_inside_repo(&canonical_target, &repo_root, "Repo-relative path")?;
            return Ok(ResolvedRepoPath {
                relative_path,
                target_path,
            });
        }

        let mut nearest_parent = target_path
            .parent()
            .ok_or_else(|| "Repo-relative path must include a parent folder.".to_string())?
            .to_path_buf();

        while !nearest_parent.exists() {
            let parent = nearest_parent.parent().ok_or_else(|| {
                format!(
                    "Unable to resolve parent folder for repo-relative path {}.",
                    relative_path
                )
            })?;
            nearest_parent = parent.to_path_buf();
        }

        let canonical_parent = nearest_parent.canonicalize().map_err(|err| {
            format!(
                "Unable to resolve parent folder {}: {}",
                nearest_parent.display(),
                err
            )
        })?;
        ensure_canonical_path_inside_repo(&canonical_parent, &repo_root, "Parent folder")?;

        Ok(ResolvedRepoPath {
            relative_path,
            target_path,
        })
    }
}

pub(crate) fn canonicalize_repo_root(repo_path: &str) -> Result<PathBuf, String> {
    let trimmed_path = repo_path.trim();
    if trimmed_path.is_empty() {
        return Err("Repository path cannot be empty.".to_string());
    }
    if trimmed_path.contains('\0') {
        return Err("Repository path cannot contain null bytes.".to_string());
    }

    let path = PathBuf::from(trimmed_path);
    if !path.is_absolute() {
        return Err("Repository path must be absolute.".to_string());
    }

    let canonical = path.canonicalize().map_err(|err| {
        format!(
            "Unable to resolve repository path {}: {}",
            path.display(),
            err
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!(
            "Repository path is not a directory: {}",
            canonical.display()
        ));
    }

    Ok(canonical)
}

fn normalize_repo_relative_path(relative_path: &str) -> Result<String, String> {
    let trimmed_path = relative_path.trim();
    if trimmed_path.is_empty() {
        return Err("Repo-relative path cannot be empty.".to_string());
    }
    if trimmed_path.contains('\0') {
        return Err("Repo-relative path cannot contain null bytes.".to_string());
    }

    let normalized = trimmed_path.replace('\\', "/");
    if normalized == "." || normalized == ".." {
        return Err("Repo-relative path cannot be '.' or '..'.".to_string());
    }
    if normalized
        .as_bytes()
        .get(1)
        .is_some_and(|value| *value == b':')
        && normalized
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
    {
        return Err("Repo-relative path cannot include a drive prefix.".to_string());
    }
    if normalized.split('/').any(|part| part.is_empty()) {
        return Err("Repo-relative path has malformed separators.".to_string());
    }

    let path = Path::new(&normalized);
    if path.is_absolute() {
        return Err("Repo-relative path cannot be absolute.".to_string());
    }

    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir | Component::ParentDir => {
                return Err("Repo-relative path cannot contain '.' or '..'.".to_string());
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("Repo-relative path cannot be rooted.".to_string());
            }
        }
    }

    Ok(normalized)
}

pub(crate) fn ensure_canonical_path_inside_repo(
    path: &Path,
    repo_root: &Path,
    label: &str,
) -> Result<(), String> {
    if path == repo_root || path.strip_prefix(repo_root).is_ok() {
        return Ok(());
    }

    Err(format!("{} must stay inside the active repository.", label))
}

pub(crate) fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
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

    fn active_boundary_for_repo(repo_root: &Path) -> ActiveRepoBoundary {
        let boundary = ActiveRepoBoundary::default();
        boundary
            .activate_repo_path(repo_root.to_str().expect("test path should be unicode"))
            .expect("test repo should activate");
        boundary
    }

    #[test]
    fn active_repo_boundary_accepts_existing_repo_relative_targets() {
        let repo_root = unique_test_project_parent("boundary-existing");
        let file_path = repo_root.join("src/app.py");
        fs::create_dir_all(file_path.parent().expect("file should have parent"))
            .expect("test directory should be created");
        fs::write(
            &file_path,
            "print('hello')
",
        )
        .expect("test file should be written");
        let boundary = active_boundary_for_repo(&repo_root);

        let resolved = boundary
            .resolve_existing_target(
                repo_root.to_str().expect("test path should be unicode"),
                "src/app.py",
            )
            .expect("repo-relative file should resolve");

        assert_eq!(resolved.relative_path, "src/app.py");
        assert_eq!(
            resolved.target_path,
            file_path
                .canonicalize()
                .expect("test file should canonicalize")
        );
        fs::remove_dir_all(repo_root).expect("test repo should be removed");
    }

    #[test]
    fn active_repo_boundary_rejects_unsafe_relative_targets_and_repo_mismatches() {
        let repo_root = unique_test_project_parent("boundary-rejects");
        let other_root = unique_test_project_parent("boundary-other");
        fs::create_dir_all(repo_root.join("src")).expect("test repo should be created");
        fs::create_dir_all(&other_root).expect("other repo should be created");
        fs::write(
            repo_root.join("src/app.py"),
            "print('hello')
",
        )
        .expect("test file should be written");
        let boundary = active_boundary_for_repo(&repo_root);
        let repo = repo_root.to_str().expect("test path should be unicode");

        for relative_path in [
            "",
            ".",
            "..",
            "../secret.txt",
            "/tmp/secret.txt",
            "src//app.py",
        ] {
            assert!(
                boundary
                    .resolve_existing_target(repo, relative_path)
                    .is_err(),
                "{relative_path:?} should be rejected"
            );
        }

        let mismatch = boundary
            .resolve_existing_target(
                other_root.to_str().expect("test path should be unicode"),
                "src/app.py",
            )
            .expect_err("stale repo paths should be rejected");
        assert!(mismatch.contains("active repository"));

        fs::remove_dir_all(repo_root).expect("test repo should be removed");
        fs::remove_dir_all(other_root).expect("other repo should be removed");
    }

    #[test]
    fn active_repo_boundary_accepts_creatable_targets_under_existing_repo_parent() {
        let repo_root = unique_test_project_parent("boundary-creatable");
        fs::create_dir_all(repo_root.join("src")).expect("test repo should be created");
        let boundary = active_boundary_for_repo(&repo_root);

        let resolved = boundary
            .resolve_creatable_target(
                repo_root.to_str().expect("test path should be unicode"),
                "src/new/module.py",
            )
            .expect("creatable target should resolve through nearest existing parent");

        assert_eq!(resolved.relative_path, "src/new/module.py");
        assert_eq!(
            resolved.target_path,
            repo_root
                .canonicalize()
                .expect("test repo should canonicalize")
                .join("src")
                .join("new")
                .join("module.py")
        );
        fs::remove_dir_all(repo_root).expect("test repo should be removed");
    }

    #[cfg(unix)]
    #[test]
    fn active_repo_boundary_rejects_symlink_escapes() {
        use std::os::unix::fs::symlink;

        let repo_root = unique_test_project_parent("boundary-symlink");
        let outside_root = unique_test_project_parent("boundary-outside");
        fs::create_dir_all(&repo_root).expect("test repo should be created");
        fs::create_dir_all(&outside_root).expect("outside dir should be created");
        fs::write(
            outside_root.join("secret.txt"),
            "secret
",
        )
        .expect("outside file should exist");
        symlink(&outside_root, repo_root.join("linked"))
            .expect("test symlink should be created on unix");
        symlink(
            outside_root.join("secret.txt"),
            repo_root.join("linked-file.txt"),
        )
        .expect("test file symlink should be created on unix");
        let boundary = active_boundary_for_repo(&repo_root);
        let repo = repo_root.to_str().expect("test path should be unicode");

        assert!(boundary
            .resolve_existing_target(repo, "linked/secret.txt")
            .is_err());
        assert!(boundary
            .resolve_creatable_target(repo, "linked/new.txt")
            .is_err());
        assert!(boundary
            .resolve_creatable_target(repo, "linked-file.txt")
            .is_err());

        fs::remove_dir_all(repo_root).expect("test repo should be removed");
        fs::remove_dir_all(outside_root).expect("outside dir should be removed");
    }
}
