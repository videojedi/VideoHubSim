# Release Workflow

Perform a full release of one of the projects.

## Instructions

Follow these steps in order:

### 0. Select Project
- Ask the user which project to release:
  - **VideoHubSim** (Router Protocol Simulator) — `/Users/richard/Documents/VideoHubSim`
  - **TieLineManager** (Tie-Line Manager) — `/Users/richard/Documents/TieLineManager`
- All subsequent steps use the selected project's directory

### 1. Bump Version
- Read the current version from `package.json`
- Ask the user what type of version bump they want (patch, minor, major) or a specific version
- Update the version in `package.json`



### 3. Build Installers
- Run `npm run build:mac` to build and sign the Mac universal DMG
- Run `npm run build:win` to build the Windows NSIS installer
- Both builds should run sequentially to avoid resource conflicts

### 4. Notarize the Mac DMG
- electron-builder's built-in notarization may not work — always notarize manually after building
- Find the DMG filename in `dist/` (it uses the productName from package.json)
- Submit the DMG to Apple: `xcrun notarytool submit "dist/<dmg-filename>" --keychain-profile "notarytool" --wait`
- The credentials are stored in the macOS keychain under the profile name `notarytool`
- Once accepted, staple the ticket: `xcrun stapler staple "dist/<dmg-filename>"`
- Both commands must succeed before proceeding

### 5. Verify Builds
- List the new builds in `dist/` directory to confirm they were created with the correct version
- Report the file sizes to the user

### 6. Commit Changes
- Stage `package.json` (and any other modified files)
- Commit with message: "Release vX.X.X"
- Do NOT include Co-Authored-By line for release commits

### 7. Push to Remote
- Push the commit to the remote repository

### 8. Create GitHub Release
- Review the commits since the previous release tag to understand what changed
- Write a human-friendly changelog body in markdown with:
  - A `## What's New` heading
  - Grouped by feature area (e.g. "### Feature Name") with bullet points describing user-facing changes
  - An "### Other Improvements" section for smaller changes
  - A `**Full Changelog**` link at the bottom comparing the previous tag to this one
- Do NOT just list commit messages — summarize changes from the user's perspective
- Create the release using `gh release create vX.X.X` with:
  - Tag: `vX.X.X` (matching the version)
  - Title: `vX.X.X`
  - The changelog body via `--notes`
  - Attach all installer files from `dist/` (`.dmg`, `.exe` — but NOT `.blockmap` or `.yml` files)

### 9. Summary
- Report the completed release with:
  - Project name
  - New version number
  - Built files and sizes
  - Git commit hash
  - GitHub release URL

  ### 10. Remove Old Builds
- Delete any existing old build `.dmg` and `.exe` files from the `dist/` directory
- Also remove any old `.blockmap` files from previous builds.
