#!/usr/bin/env bash
#
# MineDeck — установщик для Ubuntu 22.04
# Использование:
#   curl -fsSL https://raw.githubusercontent.com/denny4-user/minedeck/main/install.sh | sudo bash
#
set -euo pipefail

# --- Настройки (можно переопределить переменными окружения) -----------------
REPO="${MINEDECK_REPO:-https://github.com/denny4-user/minedeck.git}"
BRANCH="${MINEDECK_BRANCH:-main}"
INSTALL_DIR="${MINEDECK_DIR:-/opt/minedeck}"
SERVER_DIR="${MINECRAFT_DIR:-/opt/minecraft}"
SERVICE_NAME="minedeck"
NODE_MAJOR=20

# --- Цвета ------------------------------------------------------------------
G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; C='\033[0;36m'; N='\033[0m'
log()  { echo -e "${G}==>${N} $1"; }
warn() { echo -e "${Y}[!]${N} $1"; }
err()  { echo -e "${R}[x]${N} $1" >&2; }

banner() {
  echo -e "${C}"
  echo "  __  __ _            ____            _    "
  echo " |  \\/  (_)_ __   ___|  _ \\  ___  ___| | __"
  echo " | |\\/| | | '_ \\ / _ \\ | | |/ _ \\/ __| |/ /"
  echo " | |  | | | | | |  __/ |_| |  __/ (__|   < "
  echo " |_|  |_|_|_| |_|\\___|____/ \\___|\\___|_|\\_\\"
  echo -e "        Панель управления Minecraft${N}\n"
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    err "Запустите установщик с правами root (через sudo)."
    exit 1
  fi
}

# --- Установка системных зависимостей ---------------------------------------
install_base() {
  log "Обновление списков пакетов и установка зависимостей…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y -qq
  apt-get install -y -qq curl git tar ufw ca-certificates gnupg screen >/dev/null
}

install_node() {
  local ok=0
  if command -v node >/dev/null 2>&1; then
    local cur; cur="$(node -v | sed 's/v//' | cut -d. -f1)"
    if [[ "${cur}" -ge 18 ]]; then ok=1; log "Node.js уже установлен ($(node -v))"; fi
  fi
  if [[ "${ok}" -eq 0 ]]; then
    log "Установка Node.js ${NODE_MAJOR}.x (NodeSource)…"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
    log "Node.js установлен ($(node -v))"
  fi
}

install_java() {
  if command -v java >/dev/null 2>&1; then
    log "Java уже установлена: $(java -version 2>&1 | head -1)"
    return
  fi
  log "Установка Java (для Minecraft)…"
  export DEBIAN_FRONTEND=noninteractive
  if apt-get install -y -qq openjdk-21-jre-headless >/dev/null 2>&1; then
    log "Установлена Java 21"
  elif apt-get install -y -qq openjdk-17-jre-headless >/dev/null 2>&1; then
    warn "Установлена Java 17 (Java 21 недоступна в репозиториях). Для новых версий Minecraft может понадобиться Java 21."
  else
    warn "Не удалось установить Java автоматически. Установите вручную: apt install openjdk-21-jre-headless"
  fi
}

install_mariadb() {
  if [[ "${MINEDECK_SKIP_DB:-0}" == "1" ]]; then
    warn "Пропуск установки MariaDB (MINEDECK_SKIP_DB=1). Раздел «Базы данных» можно настроить позже."
    return
  fi
  if command -v mysqld >/dev/null 2>&1 || command -v mariadbd >/dev/null 2>&1; then
    log "MySQL/MariaDB уже установлена."
  else
    log "Установка MariaDB (для раздела «Базы данных»)…"
    export DEBIAN_FRONTEND=noninteractive
    if apt-get install -y -qq mariadb-server >/dev/null 2>&1; then
      log "MariaDB установлена."
    else
      warn "Не удалось установить MariaDB. Раздел «Базы данных» можно настроить позже."
      return
    fi
  fi
  systemctl enable --now mariadb >/dev/null 2>&1 || systemctl enable --now mysql >/dev/null 2>&1 || true
}

# --- Загрузка / обновление кода ---------------------------------------------
fetch_code() {
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log "Обновление MineDeck в ${INSTALL_DIR}…"
    git -C "${INSTALL_DIR}" fetch --depth 1 origin "${BRANCH}" >/dev/null 2>&1
    git -C "${INSTALL_DIR}" reset --hard "origin/${BRANCH}" >/dev/null 2>&1
  else
    log "Клонирование MineDeck в ${INSTALL_DIR}…"
    rm -rf "${INSTALL_DIR}"
    git clone --depth 1 -b "${BRANCH}" "${REPO}" "${INSTALL_DIR}" >/dev/null 2>&1
  fi
}

install_deps() {
  log "Установка npm-зависимостей…"
  cd "${INSTALL_DIR}"
  npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1
}

prepare_dirs() {
  mkdir -p "${SERVER_DIR}" "${INSTALL_DIR}/data"
  log "Директория Minecraft-сервера: ${SERVER_DIR}"
}

# --- systemd ----------------------------------------------------------------
install_service() {
  log "Настройка systemd-сервиса «${SERVICE_NAME}»…"
  local node_bin; node_bin="$(command -v node)"
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=MineDeck — панель управления Minecraft
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
ExecStart=${node_bin} ${INSTALL_DIR}/src/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1
  systemctl restart "${SERVICE_NAME}"
}

get_port() {
  node -e "try{console.log(require('${INSTALL_DIR}/data/config.json').panel.port)}catch(e){console.log(8080)}" 2>/dev/null || echo 8080
}

finish() {
  local ip port
  port="$(get_port)"
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -z "${ip}" ]] && ip="<IP-сервера>"
  echo
  log "Готово! MineDeck установлен и запущен."
  echo
  echo -e "  ${C}Веб-интерфейс:${N} http://${ip}:${port}"
  echo -e "  ${C}Первый вход:${N}   создайте логин и пароль администратора на странице входа"
  echo
  echo -e "  Управление сервисом:"
  echo -e "    systemctl status ${SERVICE_NAME}"
  echo -e "    systemctl restart ${SERVICE_NAME}"
  echo -e "    journalctl -u ${SERVICE_NAME} -f"
  echo
  warn "Если включён фаервол — откройте порт панели: ufw allow ${port}/tcp"
  warn "Не забудьте загрузить server.jar в ${SERVER_DIR} (через файловый менеджер панели)."
  echo
}

main() {
  banner
  require_root
  install_base
  install_node
  install_java
  install_mariadb
  fetch_code
  install_deps
  prepare_dirs
  install_service
  finish
}

main "$@"
