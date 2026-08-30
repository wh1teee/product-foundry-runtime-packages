# product-foundry-runtime-packages

Immutable distribution artifacts and exact static-registry snapshots for `@product-foundry/*` runtime packages.

Normal registry mutation is PR-only. Product Foundry creates a deterministic publication branch from an exact registry `main` revision after verifying the immutable release asset. The `Registry authority` workflow independently rejects mutation/removal of existing versions, mutable dist-tags, mismatched release coordinates, integrity drift, publication-time drift, or missing exact Product Foundry source identity.

Consumers must resolve packages through an exact registry commit. `main` and mutable dist-tags are never package-resolution authority.

Break glass never rewrites an immutable version or bypasses protection with force/admin mutation. Urgent stop/recovery uses Product Foundry's existing signed yank/revoke authority and a new immutable corrective release through the normal registry PR path.
