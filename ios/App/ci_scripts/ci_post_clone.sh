#!/bin/sh

# Exit immediately if a command exits with a non-zero status
set -e
# Print commands and their arguments as they are executed to the logs
set -x

echo "--- SETTING UP NODE.JS ENVIRONMENT ---"

# Install nvm (Node Version Manager)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# Source nvm to make it available in the current shell session
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Install and use Node 20
nvm install 20
nvm use 20

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
# This will now crash visibly if VITE_GOOGLE_MAPS_API_KEY is missing in App Store Connect
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
