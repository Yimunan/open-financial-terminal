# Releasing a new version (maintainer runbook)

How to go from changed sources → rebuilt installers → a GitHub release carrying **both** platform
assets (`OpenFinancialTerminal-Setup.exe` + `OpenFinancialTerminal.dmg`). This repo is standalone
(the qhfi engine is vendored at `quant-hedge-fund-incubator/`), so both builds run from a single
clone.

## 0. What kind of change is it?

| Changed | Windows | macOS |
|---|---|---|
| `backend/**` or `quant-hedge-fund-incubator/src/qhfi/**` | rebuild via CI workflow | refreeze (PyInstaller reads source live) |
| `frontend/src/**` | CI rebuilds the SPA every run | `npm run build` first, then refreeze (the spec bundles `frontend/dist`) |
| `build/oft-macos.spec`, `build/rthook_env.py` | — | copy into `backend/` first, then refreeze |
| docs / screenshots only | commit + push, no builds | — |

## 1. Build — Windows (CI, no Windows machine needed)

```sh
git push origin main

gh -R Yimunan/open-financial-terminal workflow run build-windows.yml -f version=X.Y.Z
gh -R Yimunan/open-financial-terminal run watch
gh -R Yimunan/open-financial-terminal run download --name OpenFinancialTerminal-Setup-windows-x64
```

The workflow builds the SPA (tsc fails fast) → freezes the backend (`backend/oft-backend.spec`,
which loads `rthook_env.py`) → compiles the Inno Setup installer with `/DAppVersion=X.Y.Z` →
**smoke-tests the real frozen exe** (`--server-only`, polls `/api/health` via the URL logged to
`%LOCALAPPDATA%\OpenFinancialTerminal\logs\desktop.log`) → uploads `OpenFinancialTerminal-Setup.exe`
+ `SHA256SUMS.txt`.

Local alternative (Windows 10/11 x64, Python 3.11+, Node 18+, Inno Setup 6):
`pwsh scripts\setup.ps1` once, then `pwsh scripts\build_desktop.ps1 -Installer -Version X.Y.Z`.

## 2. Build — macOS (Apple Silicon, local)

Incremental path for an existing build tree (`ROOT` with `.venv-desktop` and this repo checked out;
a sibling `quant-hedge-fund-incubator/` is preferred over the vendored copy if present):

```sh
cd $ROOT/open-financial-terminal
( cd frontend && npm run build )                     # if frontend changed
( cd backend && $ROOT/.venv-desktop/bin/pyinstaller oft-macos.spec --noconfirm \
    --distpath dist-mac --workpath build-mac )
APP="backend/dist-mac/Open Financial Terminal.app"
codesign --force --deep --sign - "$APP" && codesign --verify --deep --strict "$APP"
STAGE="$(mktemp -d)/OFT"; mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Open Financial Terminal" -srcfolder "$STAGE" \
  -ov -format UDZO "$ROOT/OpenFinancialTerminal.dmg"
```

Cold build from nothing: `bash build/build-macos.sh ~/oft-build` (see `build/README.md`).

## 3. Verify before shipping

- [ ] backend tests pass: `cd backend && <venv>/bin/python -m pytest tests/ -q`
- [ ] Windows CI run green **including the smoke-test step** (frozen exe boots, `/api/health` ok)
- [ ] macOS: install the fresh `.app`, launch, then
      `curl http://127.0.0.1:8050/api/health` → `"status":"ok"`
- [ ] **filings live** (regression guard for the SEC UA bug — the reason both specs load
      `rthook_env.py`): `curl "http://127.0.0.1:8050/api/filings?symbol=TSLA"` → `"coverage":"live"`
- [ ] macro refresh honest: `curl -X POST http://127.0.0.1:8050/api/settings/data-refresh/macro/run`
      → `"status":"ok"` with `series > 0`
- [ ] eyeball the workspace: chart renders, Ctrl+K/⌘K opens, Settings chip correct

## 4. Cut the release — both assets, constant names

Installers exceed GitHub's 100 MB file limit — they ship as **release assets**, never in git
(`.gitignore` excludes `*.exe`/`*.dmg`). Keep asset names **constant**
(`OpenFinancialTerminal-Setup.exe`, `OpenFinancialTerminal.dmg`) so the README's
`releases/latest/download/...` links always resolve; versions live in the tag.

```sh
gh -R Yimunan/open-financial-terminal release create vX.Y.Z \
  OpenFinancialTerminal-Setup.exe OpenFinancialTerminal.dmg SHA256SUMS.txt \
  --target main \
  --title "Open Financial Terminal vX.Y.Z (Windows x64 + macOS arm64)" \
  --notes "…what changed + the install blurbs for both platforms (copy a previous release)…"
```

Verify after upload:

```sh
gh -R Yimunan/open-financial-terminal release view --json tagName --jq .tagName
gh -R Yimunan/open-financial-terminal release view vX.Y.Z \
  --json assets --jq '.assets[]|"\(.name) \(.size) \(.state)"'
```

The platform distribution repos
([windows](https://github.com/Yimunan/open-financial-terminal-windows) /
[mac-os](https://github.com/Yimunan/open-financial-terminal-mac-os)) can carry the same release for
their audiences; this repo is the combined home.

## Gotchas learned the hard way

- **Both PyInstaller specs must list `runtime_hooks=["rthook_env.py"]`** — without it the frozen
  build has no compliant `SEC_USER_AGENT` (EDGAR 403s every filings fetch; dev runs mask it) and no
  seeded per-machine `OFT_SECRET_KEY`. The Windows workflow guards this and hard-fails if missing.
- The specs bundle `frontend/dist` **as it exists on disk** — a stale dist ships stale UI with no
  error. CI always rebuilds; locally, rebuild the SPA when in doubt.
- qhfi resolution is **sibling first, vendored fallback** (specs + `setup.ps1` +
  `build_desktop.ps1`) — a stale sibling checkout silently wins over the vendored engine; keep it
  in sync or remove it.
- Keep asset names and the Inno `AppId` constant across releases (stable `releases/latest` links;
  in-place upgrades).
- Windows: unsigned → SmartScreen (`INSTALL-Windows.md`); real signing via
  `build_desktop.ps1 -Sign` + a cert. macOS: ad-hoc signing only → Gatekeeper dance
  (`INSTALL-macOS.md`); real notarization needs an Apple Developer account.
- `#define AppVersion` in `oft-installer.iss` is `#ifndef`-guarded — CI passes `/DAppVersion=`;
  bumping only the tag ships an installer whose internal version lags.
