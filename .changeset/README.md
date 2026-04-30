# Changesets

This folder contains changeset files created by `pnpm changeset`. Each `.md` file describes version bumps and changelog entries for the packages being released.

## Usage

```bash
# Add a changeset
pnpm changeset

# Version packages based on pending changesets
pnpm version-packages

# Publish from CI (triggers via release workflow)
pnpm release
```

See [changesets documentation](https://github.com/changesets/changesets) for more details.
