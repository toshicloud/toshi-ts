import type { DescMethod, DescService } from "@bufbuild/protobuf";

import { services } from "../gen/toshi/workspace/v1/services.js";

/** The package the fake serves. */
export const apiPackage = "toshi.workspace.v1";

/**
 * Every service of the Workspace API, from the list `scripts/generate.sh`
 * writes beside the generated code: the fake serves each of them.
 */
export const apiServices: readonly DescService[] = services;

/** The path a client calls a method by, for example `/toshi.workspace.v1.WorkloadService/CreateJob`. */
export function procedurePath(method: DescMethod): string {
  return `/${method.parent.typeName}/${method.name}`;
}

/** Every method of the Workspace API, keyed by the path a client calls it by. */
export const apiMethods: ReadonlyMap<string, DescMethod> = buildApiMethods();

function buildApiMethods(): ReadonlyMap<string, DescMethod> {
  const found = new Map<string, DescMethod>();
  for (const service of apiServices) {
    for (const method of service.methods) {
      found.set(procedurePath(method), method);
    }
  }
  return found;
}

/** Whether method is a method of the Workspace API this package was generated from. */
export function isApiMethod(method: DescMethod): boolean {
  return apiMethods.get(procedurePath(method)) === method;
}
