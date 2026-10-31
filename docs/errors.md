# Errors


A call for a product that is off for the workspace rejects with a
`ProductError`, `wait`, the watches and `execute` included.
`isProductError(err)` tells it apart. It is still a `ConnectError` with the
same `code`, and it has the product's ID (`product`), the `reason`
(`ProductReason.Unavailable`), the input that turned the product off
(`productCause`: `build`, `operator`, `plan` or `workspace`) and, for a
product the deployment turns off, how far it has wound down (`state`:
`no_new_work`, `draining` or `stopped`).

<!-- examples/product-error.ts -->

```ts
import { isProductError } from "@toshicloud/sdk";

import { toshi } from "./client.js";

// Turn a product on for the workspace.
const enable = { id: "acme_ci", enabled: true };
try {
  await toshi.product.updateProduct(enable);
} catch (err) {
  if (!isProductError(err)) {
    throw err;
  }
  // Off for the workspace: which product, the input that turns it off, and,
  // for the deployment's config, how far it has wound down.
  console.log(err.product, err.productCause, err.state);
}
```

## Refusals with a reason

A refusal that is not a product's rejects with a `RefusalError`;
`isRefusalError(err)` tells it apart. It is still a `ConnectError` with the
same `code`, and its `reason` is one of `RefusalReason`:
`RefusalReason.ImageInUse` when an image a workload or a revision still uses
cannot be deleted, `RefusalReason.ImageNotReady` when a job, a sandbox or a
service revision names a workspace image with no ready version,
`RefusalReason.PlanExcludesImages` when the plan has no images, `RefusalReason.LastIdentity` when the caller's last identity cannot
be unlinked, and so on for images, volumes, roles and display sessions.

`workload.services.rollback` asks the revision's registry whether it still
serves the revision's image before it selects it, and refuses with
`RefusalReason.ImageNotServed` when the registry answered that it does not
serve the image, or `RefusalReason.ImageCheckFailed` when it could not say.
A revision's `imageCheck` carries the last answer: its `outcome`, the
registry's `status` and `message`, and when it was asked, `checkedAt`.
Reading a revision asks no registry.

