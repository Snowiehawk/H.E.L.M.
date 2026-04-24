#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
DEV_ENTRYPOINT="$SCRIPT_DIR/dev.py"

write_step() {
  printf '[helm launcher] %s\n' "$1"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

get_helm_profile() {
  if [ "$#" -eq 0 ]; then
    printf 'python\n'
    return
  fi

  for arg in "$@"; do
    case "$arg" in
      -h|--help|help)
        printf 'python\n'
        return
        ;;
    esac
  done

  case "$1" in
    scan)
      printf 'python\n'
      ;;
    ui)
      printf 'ui\n'
      ;;
    desktop)
      printf 'desktop\n'
      ;;
    bootstrap)
      shift
      for arg in "$@"; do
        if [ "$arg" = "--python-only" ]; then
          printf 'python\n'
          return
        fi
        if [ "$arg" = "--ui-only" ]; then
          printf 'ui\n'
          return
        fi
      done
      printf 'desktop\n'
      ;;
    *)
      printf 'python\n'
      ;;
  esac
}

python_usable() {
  local candidate="$1"
  "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1
}

refresh_shell_commands() {
  hash -r
}

linux_pkg_manager() {
  local manager
  for manager in apt-get dnf pacman zypper apk; do
    if command_exists "$manager"; then
      printf '%s\n' "$manager"
      return
    fi
  done
  return 1
}

run_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi

  if command_exists sudo; then
    sudo "$@"
    return
  fi

  printf 'HELM needs elevated privileges to install system dependencies, but sudo is unavailable.\n' >&2
  return 1
}

install_linux_packages() {
  local manager="$1"
  shift

  case "$manager" in
    apt-get)
      run_privileged apt-get update
      run_privileged apt-get install -y "$@"
      ;;
    dnf)
      run_privileged dnf install -y "$@"
      ;;
    pacman)
      run_privileged pacman -Syu --noconfirm --needed "$@"
      ;;
    zypper)
      run_privileged zypper --non-interactive install "$@"
      ;;
    apk)
      run_privileged apk add --no-progress "$@"
      ;;
    *)
      printf 'Unsupported Linux package manager: %s\n' "$manager" >&2
      return 1
      ;;
  esac
}

install_linux_desktop_packages() {
  local manager="$1"

  case "$manager" in
    apt-get)
      install_linux_packages "$manager" \
        python3 python3-venv python3-pip nodejs npm \
        libwebkit2gtk-4.1-dev build-essential curl wget file \
        libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
      ;;
    pacman)
      install_linux_packages "$manager" \
        python nodejs npm \
        webkit2gtk-4.1 base-devel curl wget file openssl \
        appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
      ;;
    dnf)
      install_linux_packages "$manager" \
        python3 nodejs npm \
        webkit2gtk4.1-devel openssl-devel curl wget file \
        libappindicator-gtk3-devel librsvg2-devel libxdo-devel
      run_privileged dnf group install -y "c-development"
      ;;
    zypper)
      install_linux_packages "$manager" \
        python3 nodejs npm \
        webkit2gtk3-devel libopenssl-devel curl wget file \
        libappindicator3-1 librsvg-devel
      run_privileged zypper --non-interactive install -t pattern devel_basis
      ;;
    apk)
      install_linux_packages "$manager" \
        python3 py3-pip py3-virtualenv nodejs npm \
        build-base webkit2gtk-4.1-dev curl wget file openssl \
        libayatana-appindicator-dev librsvg
      ;;
    *)
      printf 'Unsupported Linux package manager for desktop prerequisites: %s\n' "$manager" >&2
      return 1
      ;;
  esac
}

install_linux_ui_packages() {
  local manager="$1"

  case "$manager" in
    apt-get)
      install_linux_packages "$manager" python3 python3-venv python3-pip nodejs npm
      ;;
    pacman)
      install_linux_packages "$manager" python nodejs npm
      ;;
    dnf)
      install_linux_packages "$manager" python3 nodejs npm
      ;;
    zypper)
      install_linux_packages "$manager" python3 nodejs npm
      ;;
    apk)
      install_linux_packages "$manager" python3 py3-pip py3-virtualenv nodejs npm
      ;;
    *)
      printf 'Unsupported Linux package manager for UI prerequisites: %s\n' "$manager" >&2
      return 1
      ;;
  esac
}

install_linux_python_packages() {
  local manager="$1"

  case "$manager" in
    apt-get)
      install_linux_packages "$manager" python3 python3-venv python3-pip
      ;;
    pacman)
      install_linux_packages "$manager" python
      ;;
    dnf)
      install_linux_packages "$manager" python3
      ;;
    zypper)
      install_linux_packages "$manager" python3
      ;;
    apk)
      install_linux_packages "$manager" python3 py3-pip py3-virtualenv
      ;;
    *)
      printf 'Unsupported Linux package manager for Python prerequisites: %s\n' "$manager" >&2
      return 1
      ;;
  esac
}

ensure_brew() {
  if command_exists brew; then
    return
  fi

  printf 'Homebrew is required for HELM to auto-install missing system dependencies on macOS.\n' >&2
  exit 1
}

load_brew_env() {
  if command_exists brew; then
    eval "$("$(command -v brew)" shellenv)"
  elif [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

ensure_macos_xcode() {
  if xcode-select -p >/dev/null 2>&1; then
    return
  fi

  write_step "Requesting Xcode Command Line Tools installation."
  xcode-select --install || true
  printf 'Finish installing Xcode Command Line Tools, then rerun HELM.\n' >&2
  exit 1
}

ensure_rustup() {
  if command_exists cargo; then
    return
  fi

  if ! command_exists curl; then
    case "$(uname -s)" in
      Darwin)
        ensure_brew
        load_brew_env
        brew install curl
        ;;
      Linux)
        install_linux_packages "$(linux_pkg_manager)" curl
        ;;
    esac
  fi

  write_step "Installing Rust with rustup."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  export PATH="$HOME/.cargo/bin:$PATH"
  if command_exists rustup; then
    rustup default stable >/dev/null 2>&1 || true
  fi
  refresh_shell_commands

  if ! command_exists cargo; then
    printf 'Rust was installed, but cargo is still unavailable in this shell.\n' >&2
    exit 1
  fi
}

ensure_python_command() {
  if [ -n "${HELM_BOOTSTRAP_PYTHON_BIN:-}" ] && [ -x "${HELM_BOOTSTRAP_PYTHON_BIN}" ] && python_usable "${HELM_BOOTSTRAP_PYTHON_BIN}"; then
    HELM_PYTHON="${HELM_BOOTSTRAP_PYTHON_BIN}"
    return
  fi

  if command_exists python3 && python_usable python3; then
    HELM_PYTHON=python3
    return
  fi

  if command_exists python && python_usable python; then
    HELM_PYTHON=python
    return
  fi

  case "$(uname -s)" in
    Darwin)
      ensure_brew
      load_brew_env
      brew install python
      load_brew_env
      ;;
    Linux)
      install_linux_python_packages "$(linux_pkg_manager)"
      ;;
    *)
      printf 'Unsupported operating system for HELM bootstrap.\n' >&2
      exit 1
      ;;
  esac

  refresh_shell_commands
  if command_exists python3 && python_usable python3; then
    HELM_PYTHON=python3
    return
  fi
  if command_exists python && python_usable python; then
    HELM_PYTHON=python
    return
  fi

  printf 'HELM could not find a usable Python 3.9+ runtime after installation.\n' >&2
  exit 1
}

ensure_ui_dependencies() {
  case "$(uname -s)" in
    Darwin)
      ensure_brew
      load_brew_env
      brew install node
      load_brew_env
      ;;
    Linux)
      install_linux_ui_packages "$(linux_pkg_manager)"
      ;;
  esac
  refresh_shell_commands

  if ! command_exists node || ! command_exists npm; then
    printf 'HELM could not find node and npm after installation.\n' >&2
    exit 1
  fi
}

ensure_desktop_system_dependencies() {
  case "$(uname -s)" in
    Darwin)
      ensure_macos_xcode
      ensure_brew
      load_brew_env
      brew install node
      load_brew_env
      ensure_rustup
      ;;
    Linux)
      install_linux_desktop_packages "$(linux_pkg_manager)"
      ensure_rustup
      ;;
  esac
}

main() {
  local profile
  profile="$(get_helm_profile "$@")"

  ensure_python_command
  export PATH="$HOME/.cargo/bin:$PATH"

  case "$profile" in
    ui)
      if ! command_exists node || ! command_exists npm; then
        ensure_ui_dependencies
      fi
      ;;
    desktop)
      if ! command_exists node || ! command_exists npm || ! command_exists cargo; then
        ensure_desktop_system_dependencies
      fi
      ;;
  esac

  write_step "Running HELM via $HELM_PYTHON."
  exec "$HELM_PYTHON" "$DEV_ENTRYPOINT" "$@"
}

main "$@"
