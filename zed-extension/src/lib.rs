use serde::Deserialize;
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use zed_extension_api::{self as zed, settings::LspSettings};

#[derive(Deserialize)]
struct Manifest {
    version: String,
    repository: Option<String>,
}

fn release_url(repository: &str, version: &str) -> Result<String, String> {
    let repo = repository.trim_end_matches('/').trim_end_matches(".git");
    let path = repo
        .strip_prefix("https://github.com/")
        .ok_or("Publication requires a configured public GitHub repository.")?;
    let parts: Vec<_> = path.split('/').collect();
    let safe = |value: &str| {
        !value.is_empty()
            && value != "."
            && value != ".."
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    if parts.len() != 2 || !parts.iter().all(|part| safe(part)) || !safe(version) {
        return Err("Invalid GitHub release repository or version.".into());
    }
    Ok(format!(
        "{repo}/releases/download/v{version}/excalidraw-runtime-{version}.tar.gz"
    ))
}

fn runtime_paths(root: &Path, version: &str) -> (PathBuf, PathBuf) {
    let runtime = root.join(format!("runtime-{version}"));
    (runtime.join("src/lsp.mjs"), runtime.join(".ready"))
}

fn runtime_environment(root: &Path) -> Vec<(String, String)> {
    vec![
        (
            "PLAYWRIGHT_BROWSERS_PATH".into(),
            root.join("browsers").to_string_lossy().into_owned(),
        ),
        (
            "EXCALIDRAW_STATE_DIR".into(),
            root.join("state").to_string_lossy().into_owned(),
        ),
    ]
}

fn server_arguments(script: &str, extra: Option<Vec<String>>) -> Vec<String> {
    let mut args = vec![script.to_owned()];
    args.extend(extra.unwrap_or_else(|| vec!["--stdio".into()]));
    args
}

fn record_stage(root: &Path, message: &str) -> Result<(), String> {
    let state = root.join("state");
    fs::create_dir_all(&state).map_err(|error| error.to_string())?;
    let mut log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(state.join("download.log"))
        .map_err(|error| error.to_string())?;
    writeln!(log, "[bootstrap] {message}").map_err(|error| error.to_string())?;
    eprintln!("Excalidraw: {message}");
    Ok(())
}

struct ExcalidrawExtension;

impl ExcalidrawExtension {
    fn command(
        &mut self,
        id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> zed::Result<zed::Command> {
        let root = std::env::current_dir().map_err(|error| error.to_string())?;
        record_stage(
            &root,
            "Checking the preview runtime and Zed-managed Node.js.",
        )?;
        let settings = LspSettings::for_worktree(id.as_ref(), worktree)?;
        let binary = settings.binary;
        let node = zed::node_binary_path()?;
        let manifest: Manifest =
            toml::from_str(include_str!("../extension.toml")).map_err(|error| error.to_string())?;
        if manifest.version != env!("CARGO_PKG_VERSION") {
            return Err("Extension manifest and compiled runtime versions do not match.".into());
        }
        let script = if let Some(path) = binary.as_ref().and_then(|settings| settings.path.as_ref())
        {
            record_stage(
                &root,
                "Using the explicitly configured local language-server script.",
            )?;
            path.clone()
        } else {
            let (server, ready) = runtime_paths(&root, &manifest.version);
            if !(server.is_file() && ready.is_file()) {
                let repository = manifest.repository.as_deref().ok_or("Publication repository is not configured yet. For dev testing, configure lsp.excalidraw-preview.binary.path with a local src/lsp.mjs path.")?;
                let url = release_url(repository, &manifest.version)?;
                let runtime = root.join(format!("runtime-{}", manifest.version));
                if runtime.exists() {
                    fs::remove_dir_all(&runtime).map_err(|error| error.to_string())?;
                }
                record_stage(&root, "Downloading the versioned Excalidraw preview runtime. Detailed bootstrap messages are also available in Zed's log.")?;
                zed::set_language_server_installation_status(
                    id,
                    &zed::LanguageServerInstallationStatus::Downloading,
                );
                zed::download_file(
                    &url,
                    runtime.to_string_lossy().as_ref(),
                    zed::DownloadedFileType::GzipTar,
                )?;
                if !server.is_file()
                    || !runtime.join("runtime.json").is_file()
                    || !runtime.join("node_modules/playwright/cli.js").is_file()
                {
                    return Err("The downloaded preview runtime is incomplete. Retry the language server download.".into());
                }
                fs::write(ready, manifest.version.as_bytes()).map_err(|error| error.to_string())?;
                record_stage(&root, "Preview runtime downloaded. Chromium will be installed lazily with native progress on first PNG preview.")?;
            } else {
                record_stage(&root, "Using the cached preview runtime.")?;
            }
            server.to_string_lossy().into_owned()
        };
        let mut env: HashMap<_, _> = worktree.shell_env().into_iter().collect();
        env.extend(runtime_environment(&root));
        if let Some(extra) = binary.as_ref().and_then(|settings| settings.env.as_ref()) {
            env.extend(extra.clone());
        }
        Ok(zed::Command {
            command: node,
            args: server_arguments(&script, binary.and_then(|settings| settings.arguments)),
            env: env.into_iter().collect(),
        })
    }
}

impl zed::Extension for ExcalidrawExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> zed::Result<zed::Command> {
        zed::set_language_server_installation_status(
            id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );
        let result = self.command(id, worktree);
        match &result {
            Ok(_) => zed::set_language_server_installation_status(
                id,
                &zed::LanguageServerInstallationStatus::None,
            ),
            Err(error) => {
                if let Ok(root) = std::env::current_dir() {
                    if let Err(log_error) =
                        record_stage(&root, &format!("Preview runtime setup failed: {error}"))
                    {
                        eprintln!("Excalidraw log error: {log_error}");
                    }
                }
                zed::set_language_server_installation_status(
                    id,
                    &zed::LanguageServerInstallationStatus::Failed(error.clone()),
                );
            }
        }
        result
    }
}

zed::register_extension!(ExcalidrawExtension);

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn release_url_is_versioned_and_rejects_unconfigured_or_non_github_sources() {
        assert_eq!(
            release_url("https://github.com/example/excalidraw", "0.2.0").unwrap(),
            "https://github.com/example/excalidraw/releases/download/v0.2.0/excalidraw-runtime-0.2.0.tar.gz"
        );
        assert!(release_url("", "0.2.0").is_err());
        assert!(release_url("https://evil.example/excalidraw", "0.2.0").is_err());
        assert!(release_url("https://github.com/example/excalidraw", "../escape").is_err());
    }

    #[test]
    fn runtime_paths_and_cache_environment_stay_under_extension_work_directory() {
        let root = Path::new("/extension work directory");
        let (server, ready) = runtime_paths(root, "0.2.0");
        assert_eq!(server, root.join("runtime-0.2.0/src/lsp.mjs"));
        assert_eq!(ready, root.join("runtime-0.2.0/.ready"));
        let env = runtime_environment(root);
        assert!(env.contains(&(
            "PLAYWRIGHT_BROWSERS_PATH".into(),
            root.join("browsers").to_string_lossy().into_owned()
        )));
        assert!(env.contains(&(
            "EXCALIDRAW_STATE_DIR".into(),
            root.join("state").to_string_lossy().into_owned()
        )));
    }

    #[test]
    fn default_arguments_are_literal_paths_followed_by_stdio_flag() {
        assert_eq!(
            server_arguments("/a path/with spaces/lsp.mjs", None),
            vec!["/a path/with spaces/lsp.mjs", "--stdio"]
        );
        assert_eq!(
            server_arguments(
                "/server.mjs",
                Some(vec!["--stdio".into(), "--custom".into()])
            ),
            vec!["/server.mjs", "--stdio", "--custom"]
        );
    }
}
