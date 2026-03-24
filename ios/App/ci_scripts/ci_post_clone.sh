#!/bin/sh

echo "--- SETTING UP NODE.JS ENVIRONMENT ---"

# Install nvm (Node Version Manager)
# This is the standard and most reliable way to install Node.js in CI
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# Source nvm to make it available in the current shell session
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Install and use a specific, stable version of Node.js
# Using an LTS (Long Term Support) version is recommended for CI
nvm install 20
nvm use 20

echo "Node.js version: $(node -v)"
echo "npm version: $(npm -v)"

# Navigate to the root of the repository.
# The working directory for this script is initially ios/App/ci_scripts
cd ../../../

echo "--- INSTALLING NPM DEPENDENCIES ---"
npm install

echo "--- BUILDING WEB APP ---"
npm run build

echo "--- SYNCING CAPACITOR PROJECT --"
npx cap sync ios

echo "--- SETTING APP VERSION ---"

# Define the path to the Xcode project file
PROJECT_FILE_PATH="ios/App/App.xcodeproj/project.pbxproj"

# Read the version from package.json
PACKAGE_VERSION=$(node -p "require('./package.json').version")

echo "Version from package.json: $PACKAGE_VERSION"
echo "Xcode Cloud Build Number: $CI_BUILD_NUMBER"

# Inject the public version (e.g., 1.0.1)
sed -i '' "s/MARKETING_VERSION = .*/MARKETING_VERSION = $PACKAGE_VERSION;/g" "$PROJECT_FILE_PATH"

# Inject the internal Xcode Cloud build number (e.g., 42)
sed -i '' "s/CURRENT_PROJECT_VERSION = .*/CURRENT_PROJECT_VERSION = $CI_BUILD_NUMBER;/g" "$PROJECT_FILE_PATH"

echo "--- VERSIONING COMPLETE ---"


# Navigate back to the iOS project directory to install pods.
cd ios/App

echo "--- INSTALLING COCOAPODS ---"
pod install

echo "--- SETUP COMPLETE ---"
exit 0