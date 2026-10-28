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
