import { create, createFileRegistry, getOption, setExtension } from "@bufbuild/protobuf";
import type { DescMethod, DescService } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema, MethodOptionsSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import type { Interceptor, ServiceImpl, Transport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { SecretService } from "../src/gen/toshi/workspace/v1/secrets_pb.js";
import { services } from "../src/gen/toshi/workspace/v1/services.js";
import { WorkloadService } from "../src/gen/toshi/workspace/v1/workloads_pb.js";
import { permission } from "../src/gen/toshi/permission_pb.js";
import { retryInterceptor } from "../src/interceptors.js";
import {
  backoffDelay,
  derivedRetryClass,
  isTransportLoss,
  procedurePath,
  retryClassFor,
  retryExceptions,
} from "../src/retry.js";
import type { RetryPolicy } from "../src/retry.js";

const fastPolicy: RetryPolicy = { maxAttempts: 3, initialBackoffMs: 5, maxBackoffMs: 20 };

function transportFor<T extends DescService>(
  service: T,
  impl: Partial<ServiceImpl<T>>,
  interceptor: Interceptor,
): Transport {
  return createRouterTransport(
    (router) => {
      router.service(service, impl);
    },
    { transport: { interceptors: [interceptor] } },
  );
}

function apiMethods(): Map<string, DescMethod> {
  const found = new Map<string, DescMethod>();
  for (const service of services) {
    for (const method of service.methods) {
      found.set(procedurePath(service, method), method);
    }
  }
  return found;
}

/**
 * A service the API does not have, as a new API version could add it: its
 * calls get a class from their descriptors alone.
 */
function newService(): DescService {
  const options = (level: string) => {
    const opts = create(MethodOptionsSchema);
    setExtension(opts, permission, `example.thing.${level}`);
    return opts;
  };
  const file = create(FileDescriptorProtoSchema, {
    name: "example/v1/things.proto",
    package: "example.v1",
    syntax: "proto3",
    messageType: [
      { name: "GetThingRequest", field: [{ name: "id", number: 1, type: 9, label: 1, jsonName: "id" }] },
      {
        name: "CreateThingRequest",
        field: [{ name: "request_key", number: 1, type: 9, label: 1, jsonName: "requestKey" }],
      },
      { name: "Thing" },
    ],
    service: [
      {
        name: "ThingService",
        method: [
          { name: "GetThing", inputType: ".example.v1.GetThingRequest", outputType: ".example.v1.Thing", options: options("read") },
          { name: "CreateThing", inputType: ".example.v1.CreateThingRequest", outputType: ".example.v1.Thing", options: options("write") },
          { name: "RemoveThing", inputType: ".example.v1.GetThingRequest", outputType: ".example.v1.Thing", options: options("write") },
          {
            name: "WatchThings",
            inputType: ".example.v1.GetThingRequest",
            outputType: ".example.v1.Thing",
            serverStreaming: true,
            options: options("read"),
          },
        ],
      },
    ],
  });
  const service = createFileRegistry(file, () => undefined).getService("example.v1.ThingService");
  if (service === undefined) {
    throw new Error("example.v1.ThingService did not build");
  }
  return service;
}

describe("the retry class", () => {
  it("is the one the descriptors give every call of the API, except the listed ones", () => {
    const methods = apiMethods();
    expect(methods.size).toBeGreaterThan(0);
    for (const [path, method] of methods) {
      expect(retryClassFor(method), path).toBe(retryExceptions[path] ?? derivedRetryClass(method));
    }
  });

  it("reads the stream kind, the request_key field and the permission's level", () => {
    const methods = apiMethods();
    const get = (path: string) => {
      const method = methods.get(`/toshi.workspace.v1.${path}`);
      expect(method, path).toBeDefined();
      return retryClassFor(method as DescMethod);
    };
    expect(get("WorkloadService/GetJob")).toBe("read");
    expect(get("WorkloadService/CreateJob")).toBe("keyed");
    expect(get("WorkloadService/CancelJob")).toBe("none");
    expect(get("WorkloadService/WatchJobs")).toBe("none");
    expect(get("SecretService/PutSecret")).toBe("none");
  });

  it("gives a call a new API version adds a class, without an edit", () => {
    const service = newService();
    const classes = Object.fromEntries(service.methods.map((method) => [method.name, retryClassFor(method)]));
    expect(getOption(service.method.getThing, permission)).toBe("example.thing.read");
    expect(classes).toEqual({ GetThing: "read", CreateThing: "keyed", RemoveThing: "none", WatchThings: "none" });
  });

  it("lists an exception only for a call the API has, and only when the descriptors give it another class", () => {
    const methods = apiMethods();
    for (const [path, listed] of Object.entries(retryExceptions)) {
      const method = methods.get(path);
      expect(method, `${path} is no longer a call of the API`).toBeDefined();
      expect(derivedRetryClass(method as DescMethod), `${path} follows the rule now; remove it from the list`).not.toBe(
        listed,
      );
    }
  });
});

describe("isTransportLoss", () => {
  it("does not treat a write after the server answered as a loss", () => {
    const writeAfterEnd = Object.assign(new Error("w"), { code: "ERR_STREAM_WRITE_AFTER_END" });
    expect(isTransportLoss(new ConnectError("x", Code.Aborted, undefined, undefined, writeAfterEnd))).toBe(
      false,
    );
  });
});

describe("retryInterceptor", () => {
  it("retries Unavailable for a read up to maxAttempts", async () => {
    let attempts = 0;
    const transport = transportFor(
      WorkloadService,
      {
        getJob() {
          attempts += 1;
          throw new ConnectError("down", Code.Unavailable);
        },
      },
      retryInterceptor(fastPolicy),
    );
    const workload = createClient(WorkloadService, transport);
    await expect(workload.getJob({ id: "w" })).rejects.toMatchObject({
      code: Code.Unavailable,
    });
    expect(attempts).toBe(3);
  });

  it("retries Unavailable for a keyed write up to maxAttempts", async () => {
    let attempts = 0;
    const transport = transportFor(
      WorkloadService,
      {
        createJob() {
          attempts += 1;
          throw new ConnectError("down", Code.Unavailable);
        },
      },
      retryInterceptor(fastPolicy),
    );
    const workload = createClient(WorkloadService, transport);
    await expect(workload.createJob({})).rejects.toMatchObject({ code: Code.Unavailable });
    expect(attempts).toBe(3);
  });

  it("does not retry a none-class write", async () => {
    let attempts = 0;
    const transport = transportFor(
      SecretService,
      {
        putSecret() {
          attempts += 1;
          throw new ConnectError("down", Code.Unavailable);
        },
      },
      retryInterceptor(fastPolicy),
    );
    const secrets = createClient(SecretService, transport);
    await expect(secrets.putSecret({})).rejects.toMatchObject({ code: Code.Unavailable });
    expect(attempts).toBe(1);
  });

  it("does not retry a server-sent Aborted", async () => {
    let attempts = 0;
    const transport = transportFor(
      WorkloadService,
      {
        getJob() {
          attempts += 1;
          throw new ConnectError("cancelled by the server", Code.Aborted);
        },
      },
      retryInterceptor(fastPolicy),
    );
    const workload = createClient(WorkloadService, transport);
    await expect(workload.getJob({ id: "w" })).rejects.toMatchObject({
      code: Code.Aborted,
    });
    expect(attempts).toBe(1);
  });

  it("does not retry InvalidArgument or ResourceExhausted", async () => {
    for (const code of [Code.InvalidArgument, Code.ResourceExhausted]) {
      let attempts = 0;
      const transport = transportFor(
        WorkloadService,
        {
          getJob() {
            attempts += 1;
            throw new ConnectError("refused", code);
          },
        },
        retryInterceptor(fastPolicy),
      );
      const workload = createClient(WorkloadService, transport);
      await expect(workload.getJob({ id: "w" })).rejects.toMatchObject({ code });
      expect(attempts).toBe(1);
    }
  });

  it("rejects at once when the signal aborts during the backoff sleep", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const policy: RetryPolicy = { maxAttempts: 3, initialBackoffMs: 60_000, maxBackoffMs: 60_000 };
    const transport = transportFor(
      WorkloadService,
      {
        getJob() {
          attempts += 1;
          // Abort as the interceptor turns to a sleep of up to a minute.
          controller.abort();
          throw new ConnectError("down", Code.Unavailable);
        },
      },
      retryInterceptor(policy),
    );
    const workload = createClient(WorkloadService, transport);
    const started = Date.now();
    await expect(
      workload.getJob({ id: "w" }, { signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(attempts).toBe(1);
  });

  it("never backs off past maxBackoffMs", () => {
    const policy: RetryPolicy = { maxAttempts: 3, initialBackoffMs: 5, maxBackoffMs: 20 };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const limit = Math.min(policy.maxBackoffMs, policy.initialBackoffMs * 2 ** attempt);
      for (let round = 0; round < 100; round += 1) {
        const delay = backoffDelay(policy, attempt);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(limit);
      }
    }
  });
});
