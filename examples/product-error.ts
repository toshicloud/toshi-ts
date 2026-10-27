import { isProductError, ProductReason } from "@toshicloud/sdk";

import { toshi } from "./client.js";

// Turning an outside product on installs it, and the API asks the caller to
// accept the access it wants first.
const enable = { id: "acme_ci", enabled: true, acceptedAccess: [] as string[] };
try {
  try {
    await toshi.product.updateProduct(enable);
  } catch (err) {
    if (!isProductError(err) || err.reason !== ProductReason.AccessNotAccepted) {
      throw err;
    }
    console.log(err.product, err.reason, err.access);
    // Accept exactly the access the product asks for.
    await toshi.product.updateProduct({ ...enable, acceptedAccess: err.access });
  }
} catch (err) {
  if (!isProductError(err)) {
    throw err;
  }
  // Off for the workspace: say which product and why.
  console.log(err.product, err.reason, err.feature);
}
