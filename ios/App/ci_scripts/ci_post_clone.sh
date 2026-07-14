#!/bin/sh

# Exit immediately if a command exits with a non-zero status
set -e
# Print commands and their arguments as they are executed to the logs
set -x

echo "--- SETTING UP NODE.JS ENVIRONMENT ---"

# nodejs.org is intermittently unreachable from Xcode Cloud runners, which broke
# the previous nvm-based install. Homebrew is preinstalled on Xcode Cloud and
# fetches from GitHub's registry, so install Node 24 (matches Android CI) from it.
brew install node@24
export PATH="$(brew --prefix node@24)/bin:$PATH"

echo "Node.js version: $(node -v)"
echo "npm version: $(npm -v)"

# Navigate safely to the root of the repository using Xcode Cloud env vars
if [ -n "$CI_PRIMARY_REPOSITORY_PATH" ]; then
    cd "$CI_PRIMARY_REPOSITORY_PATH"
else
    cd ../../../
fi

echo "--- INSTALLING NPM DEPENDENCIES ---"
npm install

echo "--- BUILDING WEB APP ---"
# Vite silently embeds undefined if the key is missing, so fail loudly here instead.
# Set VITE_GOOGLE_MAPS_API_KEY in the Xcode Cloud workflow's Environment settings.
if [ -z "${VITE_GOOGLE_MAPS_API_KEY:-}" ]; then
    echo "ERROR: VITE_GOOGLE_MAPS_API_KEY is not set in the Xcode Cloud workflow environment."
    exit 1
fi
npm run build

echo "--- SYNCING CAPACITOR PROJECT --"
npx cap sync ios

echo "--- SETTING APP VERSION ---"
PROJECT_FILE_PATH="ios/App/App.xcodeproj/project.pbxproj"
PACKAGE_VERSION=$(node -p "require('./package.json').version")

echo "Version from package.json: $PACKAGE_VERSION"
echo "Xcode Cloud Build Number: $CI_BUILD_NUMBER"

sed -i '' "s/MARKETING_VERSION = .*/MARKETING_VERSION = $PACKAGE_VERSION;/g" "$PROJECT_FILE_PATH"
sed -i '' "s/CURRENT_PROJECT_VERSION = .*/CURRENT_PROJECT_VERSION = $CI_BUILD_NUMBER;/g" "$PROJECT_FILE_PATH"

echo "--- VERSIONING COMPLETE ---"

# Navigate back to the iOS project directory to install pods.
cd ios/App

echo "--- INSTALLING COCOAPODS ---"
pod install

echo "--- SETUP COMPLETE ---"
exit 0
