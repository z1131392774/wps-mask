# A junction instead of copying the add-in

*[中文](2026-11-24-junction-for-the-installed-addon_zh.md)*

## Problem

WPS loads an add-in from `%APPDATA%\kingsoft\wps\jsaddons\wpsmask_1.0.0`, which is outside the repository, so every code change needed a manual copy. Two failure modes came out of that. A forgotten copy looked exactly like a fix that did not work — the old behaviour reappeared and the code was already correct. And editing the installed copy instead, which is the natural way to test a one-line tweak, produced a change with no version control behind it and one that the next full copy would overwrite.

## Decision

`tools/link-addon.ps1` makes the installed folder a directory junction onto the working tree, so there is one set of files. It renames any existing real folder to `wpsmask_1.0.0.bak-<timestamp>` first, verifies that `js\engine.js` reads back through the link, and `-Rollback` removes the junction and restores that backup. Restarting WPS is then the only step between an edit and the running add-in.

## Alternatives considered

**Symbolic link.** Rejected: creating one needs either elevation or developer mode, and the script would fail on a default Windows account with an error that has nothing to do with the add-in.

**Hard link.** Rejected: hard links only exist for files. A folder cannot be hard-linked, so this would mean linking each file and keeping the set in sync by hand.

**`wpsjs debug`.** Rejected as the only path: it requires the node toolchain, while this repository deliberately ships plain files that install by copy. It stays mentioned in the manual for people who already have `wpsjs`.

**A sync script that copies on demand.** Rejected: still two copies, and it only helps someone who remembers to run it — which is the original problem.

**Editing in `jsaddons` and copying back.** Rejected: the installed folder is not a working directory, has no history, and disappears when the version number changes.

## Consequences

WPS must be closed to link or roll back, because a loaded add-in holds the folder and the rename fails; the script says so in that error. `publish.xml` is still a one-time copy, since it describes every add-in in that directory and the script must not rewrite it. Moving the working tree leaves the junction dangling and needs one more run. The `.bak-<timestamp>` folder can be deleted once the linked add-in is confirmed working.
