import assert from "node:assert/strict";
import test from "node:test";

import { validateRegistryMetadataDelta } from "./verify-registry-pr.mjs";

const prior = {
  name: "@product-foundry/errors",
  "dist-tags": {},
  versions: {
    "0.1.0": {
      name: "@product-foundry/errors",
      version: "0.1.0",
      dist: {
        tarball: "https://github.com/wh1teee/product-foundry-runtime-packages/releases/download/errors-v0.1.0/product-foundry-errors-0.1.0.tgz",
        integrity: "sha512-old",
      },
    },
  },
  time: {
    created: "2026-08-17T19:00:00.000Z",
    modified: "2026-08-17T19:00:00.000Z",
    "0.1.0": "2026-08-17T19:00:00.000Z",
  },
};

const next = structuredClone(prior);
next.versions["0.1.1"] = {
  name: "@product-foundry/errors",
  version: "0.1.1",
  dist: {
    tarball: "https://github.com/wh1teee/product-foundry-runtime-packages/releases/download/errors-v0.1.1/product-foundry-errors-0.1.1.tgz",
    integrity: `sha512-${"A".repeat(86)}==`,
  },
};
next.time["0.1.1"] = "2026-08-30T20:00:00.000Z";
next.time.modified = "2026-08-30T20:00:00.000Z";

test("registry delta is append-only and binds a new version to its immutable release asset", () => {
  const additions = validateRegistryMetadataDelta({
    registryPath: "registry/@product-foundry/errors",
    before: prior,
    after: next,
  });
  assert.deepEqual(additions, [{
    packageId: "errors",
    packageName: "@product-foundry/errors",
    version: "0.1.1",
    tarball: next.versions["0.1.1"].dist.tarball,
    integrity: next.versions["0.1.1"].dist.integrity,
    publishedAt: "2026-08-30T20:00:00.000Z",
  }]);
});

test("registry delta rejects mutation of an existing immutable version", () => {
  const mutated = structuredClone(next);
  mutated.versions["0.1.0"].dist.integrity = "sha512-mutated";
  assert.throws(() => validateRegistryMetadataDelta({
    registryPath: "registry/@product-foundry/errors",
    before: prior,
    after: mutated,
  }), /existing registry version changed/u);
});

test("registry delta rejects mutable dist-tags and wrong release coordinates", () => {
  const tagged = structuredClone(next);
  tagged["dist-tags"].latest = "0.1.1";
  assert.throws(() => validateRegistryMetadataDelta({
    registryPath: "registry/@product-foundry/errors",
    before: prior,
    after: tagged,
  }), /dist-tags must remain empty/u);

  const wrongAsset = structuredClone(next);
  wrongAsset.versions["0.1.1"].dist.tarball = "https://example.com/errors.tgz";
  assert.throws(() => validateRegistryMetadataDelta({
    registryPath: "registry/@product-foundry/errors",
    before: prior,
    after: wrongAsset,
  }), /immutable GitHub release asset/u);
});
