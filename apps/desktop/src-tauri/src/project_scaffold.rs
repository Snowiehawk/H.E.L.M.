use crate::atomic_file::{atomic_write_text, unique_temp_sibling};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewProjectResult {
    project_path: String,
    package_name: String,
}

pub(crate) fn validate_new_project_path(project_path: &str) -> Result<PathBuf, String> {
    let trimmed_path = project_path.trim();
    if trimmed_path.is_empty() {
        return Err("Project path cannot be empty.".to_string());
    }
    if trimmed_path.contains('\0') {
        return Err("Project path cannot contain null bytes.".to_string());
    }

    let path = PathBuf::from(trimmed_path);
    if !path.is_absolute() {
        return Err("Project path must be absolute.".to_string());
    }
    if path.exists() {
        return Err(format!("Project folder already exists: {}", path.display()));
    }

    let file_name = path
        .file_name()
        .ok_or_else(|| "Project path must include a folder name.".to_string())?;
    let file_name_text = file_name
        .to_str()
        .ok_or_else(|| "Project folder name must be valid Unicode.".to_string())?
        .trim();
    if file_name_text.is_empty() || file_name_text == "." || file_name_text == ".." {
        return Err("Project folder name is not safe.".to_string());
    }

    let parent = path
        .parent()
        .ok_or_else(|| "Project path must include a parent folder.".to_string())?;
    let canonical_parent = parent.canonicalize().map_err(|err| {
        format!(
            "Unable to resolve project parent folder {}: {}",
            parent.display(),
            err
        )
    })?;
    if !canonical_parent.is_dir() {
        return Err(format!(
            "Parent path is not a folder: {}",
            canonical_parent.display()
        ));
    }

    Ok(canonical_parent.join(file_name))
}

pub(crate) fn create_python_package_project(
    project_path: &Path,
) -> Result<NewProjectResult, String> {
    let parent = project_path
        .parent()
        .ok_or_else(|| "Project path must include a parent folder.".to_string())?;
    if !parent.exists() {
        return Err(format!(
            "Parent folder does not exist: {}",
            parent.display()
        ));
    }
    if !parent.is_dir() {
        return Err(format!("Parent path is not a folder: {}", parent.display()));
    }
    if project_path.exists() {
        return Err(format!(
            "Project folder already exists: {}",
            project_path.display()
        ));
    }

    let project_name = project_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Project folder name must be valid Unicode.".to_string())?;
    let project_name = project_name.trim();
    if project_name.is_empty() {
        return Err("Project folder name cannot be empty.".to_string());
    }

    let package_name = sanitize_python_package_name(project_name);
    let temp_project_path = unique_temp_sibling(parent)?;
    fs::create_dir(&temp_project_path).map_err(|err| {
        format!(
            "Unable to create temporary project folder {}: {}",
            temp_project_path.display(),
            err
        )
    })?;

    let scaffold_result =
        write_python_package_scaffold(&temp_project_path, project_name, &package_name);
    if let Err(err) = scaffold_result {
        let _ = fs::remove_dir_all(&temp_project_path);
        return Err(err);
    }

    if let Err(err) = fs::rename(&temp_project_path, project_path) {
        let _ = fs::remove_dir_all(&temp_project_path);
        return Err(format!(
            "Unable to finalize project folder {}: {}",
            project_path.display(),
            err
        ));
    }

    Ok(NewProjectResult {
        project_path: project_path
            .canonicalize()
            .unwrap_or_else(|_| project_path.to_path_buf())
            .to_string_lossy()
            .into_owned(),
        package_name,
    })
}

fn write_python_package_scaffold(
    project_path: &Path,
    project_name: &str,
    package_name: &str,
) -> Result<(), String> {
    let package_dir = project_path.join("src").join(package_name);
    let tests_dir = project_path.join("tests");
    fs::create_dir_all(&package_dir).map_err(|err| {
        format!(
            "Unable to create package folder {}: {}",
            package_dir.display(),
            err
        )
    })?;
    fs::create_dir_all(&tests_dir).map_err(|err| {
        format!(
            "Unable to create tests folder {}: {}",
            tests_dir.display(),
            err
        )
    })?;

    let distribution_name = package_name.replace('_', "-");
    write_project_file(
        &project_path.join("README.md"),
        format!(
            "# {}\n\nA Python project created with H.E.L.M.\n",
            project_name
        ),
    )?;
    write_project_file(
        &project_path.join(".gitignore"),
        ".venv/\n__pycache__/\n.pytest_cache/\n*.py[cod]\ndist/\nbuild/\n*.egg-info/\n.helm/recovery/\n".to_string(),
    )?;
    write_project_file(
        &project_path.join("pyproject.toml"),
        format!(
            "[build-system]\n\
             requires = [\"setuptools>=61\"]\n\
             build-backend = \"setuptools.build_meta\"\n\n\
             [project]\n\
             name = \"{}\"\n\
             version = \"0.1.0\"\n\
             description = \"A Python project created with H.E.L.M.\"\n\
             readme = \"README.md\"\n\
             requires-python = \">=3.9\"\n\n\
             [tool.setuptools]\n\
             package-dir = {{ \"\" = \"src\" }}\n\n\
             [tool.setuptools.packages.find]\n\
             where = [\"src\"]\n",
            distribution_name
        ),
    )?;
    write_project_file(
        &package_dir.join("__init__.py"),
        "from .main import greet\n\n__all__ = [\"greet\"]\n".to_string(),
    )?;
    write_project_file(
        &package_dir.join("main.py"),
        r#"def greet(name: str = "world") -> str:
    return f"Hello, {name}!"


def main() -> None:
    print(greet())


if __name__ == "__main__":
    main()
"#
        .to_string(),
    )?;
    write_project_file(
        &tests_dir.join("test_smoke.py"),
        format!(
            "from {}.main import greet\n\n\n\
def test_greet_returns_name():\n\
    assert greet(\"H.E.L.M.\") == \"Hello, H.E.L.M.!\"\n",
            package_name
        ),
    )?;

    Ok(())
}

fn write_project_file(path: &Path, content: String) -> Result<(), String> {
    atomic_write_text(path, &content)
}

fn sanitize_python_package_name(name: &str) -> String {
    let mut normalized = String::new();
    let mut last_was_underscore = false;

    for character in name.trim().chars() {
        if character.is_ascii_alphanumeric() {
            normalized.push(character.to_ascii_lowercase());
            last_was_underscore = false;
            continue;
        }

        if !last_was_underscore && !normalized.is_empty() {
            normalized.push('_');
            last_was_underscore = true;
        }
    }

    let trimmed = normalized.trim_matches('_').to_string();
    let mut candidate = if trimmed.is_empty() {
        "project".to_string()
    } else {
        trimmed
    };

    if !candidate
        .chars()
        .next()
        .map(|character| character.is_ascii_alphabetic())
        .unwrap_or(false)
        || is_python_keyword(&candidate)
    {
        candidate = format!("project_{}", candidate);
    }

    candidate
}

fn is_python_keyword(value: &str) -> bool {
    matches!(
        value,
        "false"
            | "none"
            | "true"
            | "and"
            | "as"
            | "assert"
            | "async"
            | "await"
            | "break"
            | "class"
            | "continue"
            | "def"
            | "del"
            | "elif"
            | "else"
            | "except"
            | "finally"
            | "for"
            | "from"
            | "global"
            | "if"
            | "import"
            | "in"
            | "is"
            | "lambda"
            | "nonlocal"
            | "not"
            | "or"
            | "pass"
            | "raise"
            | "return"
            | "try"
            | "while"
            | "with"
            | "yield"
    )
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
    fn sanitize_python_package_name_keeps_valid_identifiers() {
        assert_eq!(sanitize_python_package_name("Cool App"), "cool_app");
        assert_eq!(
            sanitize_python_package_name("123 Cool-App!"),
            "project_123_cool_app"
        );
        assert_eq!(sanitize_python_package_name("class"), "project_class");
        assert_eq!(sanitize_python_package_name("!!!"), "project");
    }

    #[test]
    fn create_python_package_project_writes_template_files() {
        let parent = unique_test_project_parent("scaffold");
        let project_path = parent.join("Cool App");
        fs::create_dir_all(&parent).expect("test parent should be created");

        let result = create_python_package_project(&project_path)
            .expect("project scaffold should be created");

        assert_eq!(result.package_name, "cool_app");
        assert!(project_path.join("README.md").is_file());
        assert!(project_path.join(".gitignore").is_file());
        assert!(project_path.join("pyproject.toml").is_file());
        assert!(project_path.join("src/cool_app/__init__.py").is_file());
        assert!(project_path.join("src/cool_app/main.py").is_file());
        assert!(project_path.join("tests/test_smoke.py").is_file());
        let gitignore = fs::read_to_string(project_path.join(".gitignore"))
            .expect(".gitignore should be readable");
        assert!(gitignore.contains(".helm/recovery/"));
        assert_eq!(helm_new_project_temp_sibling_count(&parent), 0);

        let main_source = fs::read_to_string(project_path.join("src/cool_app/main.py"))
            .expect("main.py should be readable");
        assert!(main_source.contains("def greet"));
        assert!(main_source.contains(r#"return f"Hello, {name}!""#));

        fs::remove_dir_all(parent).expect("test project should be removed");
    }

    fn helm_new_project_temp_sibling_count(parent: &Path) -> usize {
        fs::read_dir(parent)
            .expect("test parent should be readable")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".helm-new-project-")
            })
            .count()
    }

    #[test]
    fn create_python_package_project_rejects_existing_folder() {
        let parent = unique_test_project_parent("existing");
        let project_path = parent.join("Existing App");
        fs::create_dir_all(&project_path).expect("existing project folder should be created");

        let error = create_python_package_project(&project_path)
            .expect_err("existing project folder should be rejected");

        assert!(error.contains("already exists"));
        fs::remove_dir_all(parent).expect("test project should be removed");
    }
}
