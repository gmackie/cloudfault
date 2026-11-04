# Releasing @gmacko/cloudfault

Only `@gmacko/cloudfault` is published. The `@cloudfault/*` workspace packages are private and are folded into its `dist/`.

Publishing to npm is done by hand, with `npm login` and 2FA, not with a CI token, because npm is retiring long-lived publish tokens. CI builds, tests and packs the tarball. A person publishes it.

## Steps

1. Bump `packages/cloudfault/package.json`, run `npm run sync-versions`, and merge to `main`.
2. The **Release** workflow notices that the version is newer than npm's. It runs the full test suite, packs the package, uploads `gmacko-cloudfault-<version>.tgz` as a workflow artifact, and prints its shasum in the job summary.
3. Download that artifact, or build the identical tarball locally from the merge commit with `npm run pack`. Check that its shasum matches the job summary.
4. Publish it:

   ```bash
   npm login --registry https://registry.npmjs.org/
   npm publish gmacko-cloudfault-<version>.tgz --access public --registry https://registry.npmjs.org/
   ```

   npm then asks for 2FA, either in the browser or as a one-time password.
5. Tag the merge commit `v<version>` and push the tag. The README and `docs/ci.md` reference the composite action by tag (`gmackie/cloudfault@v<version>`).
6. Check with `npm view @gmacko/cloudfault@<version> dist.shasum`.

## ForgeGraph registry

ForgeGraph's default advisory check (FORGE-310) installs the CLI from the ForgeGraph registry (`npm.forgegraf.com`), not from npm. That registry stores the `@gmacko` scope itself and never proxies it to npm. To publish the same tarball there:

```bash
forge registry token create --label "publish @gmacko/cloudfault <version> (revoke after)" --expires-in-days 1
npm publish gmacko-cloudfault-<version>.tgz --registry https://npm.forgegraf.com/ --userconfig <file holding that token>
forge registry token revoke <id>
```

Then set `FG_CLOUDFAULT_CLI = "@gmacko/cloudfault@<version>"` in ForgeGraph's `apps/web/wrangler*.toml`.
