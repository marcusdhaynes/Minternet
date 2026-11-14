# Minternet — Main-Only Development

The canonical branch is **main**. Application edits, fixes, tests, and releases belong there. No other active branches should be kept.

On 2026-11-14 the 18 divergent legacy branch heads were preserved as parent commits of a consolidation merge on main; all 21 previous non-main branch names are recorded in the retired branch manifest. The current tested application file tree was deliberately retained, rather than replaying old and conflicting versions of browser code.

GitHub Actions enforces this by inspecting branch creation and all branch pushes, and by rechecking hourly. If future unmerged commits exist on a branch, the cleanup archives its head as a Git tag before deleting the branch. Tags are immutable historical references for recovery, not branches or new app builds.

Only main may build or publish a Windows EXE. Manual build dispatch from another ref is skipped. The release archiver rejects off-main run IDs. The old static EXE publishing workflow and Dependabot version-update configuration are removed.

**Limit:** An Actions cleanup workflow cannot prohibit the creation of a branch in the GitHub API itself. A repository administrator can add a GitHub branch ruleset forbidding the creation of refs/heads/* except refs/heads/main. Without that extra repository-level permission change, accidental branches may exist briefly before automated removal.
