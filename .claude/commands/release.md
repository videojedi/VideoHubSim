# Release Workflow

Perform a full release of the Router Protocol Simulator:

1. Bump the version number in package.json (ask which type: patch/minor/major)
2. Update README.md with release notes for this version
3. Commit all changes with a version bump message
4. Push to the repository
5. Build for Mac and Windows (npm run build:mac && npm run build:win)
6. Sign and notarize the Mac version
7. Create a GitHub release with the built artifacts
8. Remove old builds from the dist folder (keep only current version)

Ask for confirmation before starting, and confirm the version bump type.
