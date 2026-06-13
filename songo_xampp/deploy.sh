#!/bin/bash
# Déploie la version locale Songo dans le dossier htdocs de XAMPP.
# Usage : ./deploy.sh

set -e

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="/opt/lampp/htdocs/songo"

if [ ! -d "/opt/lampp/htdocs" ]; then
    echo "Erreur : XAMPP introuvable (/opt/lampp/htdocs)."
    echo "Installez XAMPP ou modifiez TARGET_DIR dans ce script."
    exit 1
fi

echo "Déploiement vers ${TARGET_DIR} …"
mkdir -p "$TARGET_DIR"
cp -r "$SOURCE_DIR/index.html" "$SOURCE_DIR/script.js" "$SOURCE_DIR/css" "$SOURCE_DIR/audio" "$TARGET_DIR/"
chmod -R a+rX "$TARGET_DIR" 2>/dev/null || true

echo "Terminé. Ouvrez : http://localhost/songo/"
