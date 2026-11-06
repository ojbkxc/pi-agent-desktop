# Desktop release updates

`pi-agent-desktop` 会将已安装的 macOS、Windows 或 Linux 应用作为一个由 updater 签名的完整包更新。该安装包会记录三个组件在 `src-tauri/resources/component-versions.json` 中的确切版本：

1. `pi-agent-desktop` —— 由**发布本版本的仓库**解析（CI 里是 `GITHUB_REPOSITORY`，本地回退到本 fork），不是硬编码的上游名；
2. `earendil-works/pi`
3. `agegr/pi-web`

The settings screen checks only the latest stable release of the repository this build publishes from, at most once a week. If the installed desktop app version is older, its single **Upgrade** button downloads that signed release, installs the complete app, and restarts it. It never replaces JavaScript or dependencies inside an already installed signed app.

## Automatic component sync

`.github/workflows/component-updates.yml` runs nightly (a `schedule` cron) and can also be started by hand (`workflow_dispatch`). A schedule is the only trigger that keeps working if the upstream `abcwyc/pi-agent-desktop` repository ever disappears: a third-party repository cannot be made to send this fork a `repository_dispatch`, and the fork's own Releases are what users install. It applies updates in dependency order:

1. update all `@earendil-works/pi-*` packages to the released `pi` version;
2. merge the released `pi-web` tag;
3. restore any `git+ssh://` URL npm may have rewritten in `package-lock.json` back to `git+https://`, so the next `npm ci` needs no SSH key;
4. bump `pi-agent-desktop`, regenerate the component manifest, and run tests, typecheck, lint, and a full desktop build;
5. commit the verified result and decide how to publish it (below).

Pushes use no force option, and history on `main` is never rewritten. The fork boundary (`scripts/fork-ownership.json`) decides between two outcomes:

- **No overlap with fork-owned files** — the sync pushes `main` and immediately dispatches `release.yml`. `release.yml` stays `workflow_dispatch`-only; a GITHUB_TOKEN dispatch is one of the two events allowed to start a new run, and the release's own `concurrency` group (`pi-agent-desktop-release`, `cancel-in-progress: false`) keeps it from cancelling a build already in flight.
- **Overlap with fork-owned files (`review_required`)** — a clean merge can still be a silent semantic conflict, so nothing reaches `main` and **no release is dispatched**. The sync opens a review PR instead; a human merges it and dispatches `release.yml` by hand once satisfied. This path is never silent.

If an upstream merge conflicts or any validation fails, the workflow stops before updating `main` or publishing a Release, and the failed Actions run must be resolved manually. A sync already sitting in a review PR is skipped on later nights rather than retried.

## One-time signing setup

Tauri updater signatures are mandatory. Generate the updater signing key once on a trusted machine:

```bash
npm exec tauri signer generate -- -w ~/.tauri/pi-agent-desktop.key
```

Store these repository Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`: contents of the private key file;
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: password chosen during generation;
- `TAURI_UPDATER_PUBLIC_KEY`: the exact Base64 contents of the `.pub` file generated next to the private key.

The release workflow validates this public key before installing dependencies and
injects it into Tauri's updater configuration for both bundle signing and runtime
verification. The key is never printed by the workflow.

Never commit the private key or its password. The public key is embedded at compile time only in release builds. Local builds deliberately do not register the updater plugin.

## Publishing

After a component sync reaches `main` through the no-overlap path, it explicitly starts **Publish signed desktop release**. When the sync instead went through a review PR (`review_required`), dispatch it by hand after merging. The release workflow can also be started manually at any time. It verifies that the bundled `pi` and `pi-web` versions exactly match their latest stable Releases, then sequentially creates Apple Silicon (`aarch64`) DMG/updater artifacts, a Linux x64 `.deb`, and a Windows x64 NSIS `-setup.exe`/updater archive. Intel Mac (`x86_64-apple-darwin`) artifacts are not built. The Release stays in draft until all platforms and the component manifest are present; only then is `v<pi-agent-desktop version>` published as the latest Release.

The workflow currently uses ad-hoc macOS application signing, Tauri updater signatures, and the native Linux package format. Before distributing outside a controlled environment, configure an Apple Developer ID certificate/notarization and a Windows Authenticode certificate. Without Authenticode, Windows may show a SmartScreen warning even though updater verification remains cryptographically signed.
