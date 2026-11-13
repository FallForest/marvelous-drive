# release/

Committed release artefacts.

`latest.json` is the manifest the in-app update check and the update agent
read: `version`, `image`, `releaseUrl`, `notesUrl`. It is bumped with the version
during a release (see [docs/RELEASING.md](../docs/RELEASING.md)) and regenerated
by `.github/workflows/release.yml`, which publishes the same file as a release
asset so a deployed instance can fetch it without cloning the repository.

To let a deployment see it, point `DRIVE_UPDATE_MANIFEST_URL` at the asset:

```
DRIVE_UPDATE_MANIFEST_URL=https://github.com/<owner>/marvelous-drive/releases/latest/download/latest.json
```
