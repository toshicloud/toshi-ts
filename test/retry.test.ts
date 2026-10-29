import { getOption } from "@bufbuild/protobuf";
import type { DescMethod, DescService } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import type { Interceptor, ServiceImpl, Transport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { ArtifactService, ArtifactUploadService } from "../src/gen/toshi/workspace/v1/artifacts_pb.js";
import { AuditEventService } from "../src/gen/toshi/workspace/v1/audit_events_pb.js";
import { ChannelService } from "../src/gen/toshi/workspace/v1/channels_pb.js";
import { DiscoveryService } from "../src/gen/toshi/workspace/v1/discovery_pb.js";
import { ConnectionService } from "../src/gen/toshi/workspace/v1/connections_pb.js";
import { RoleService } from "../src/gen/toshi/workspace/v1/roles_pb.js";
import { DisplayService } from "../src/gen/toshi/workspace/v1/display_pb.js";
import { FillerService } from "../src/gen/toshi/workspace/v1/fillers_pb.js";
import { GrantService } from "../src/gen/toshi/workspace/v1/grants_pb.js";
import { HostJobService } from "../src/gen/toshi/workspace/v1/hostjobs_pb.js";
import { HostService } from "../src/gen/toshi/workspace/v1/hosts_pb.js";
import { ProductService } from "../src/gen/toshi/workspace/v1/products_pb.js";
import { ProjectService } from "../src/gen/toshi/workspace/v1/projects_pb.js";
import { RecordingService } from "../src/gen/toshi/workspace/v1/recordings_pb.js";
import { SecretService } from "../src/gen/toshi/workspace/v1/secrets_pb.js";
import { StorageProviderService } from "../src/gen/toshi/workspace/v1/storage_providers_pb.js";
import { TokenService } from "../src/gen/toshi/workspace/v1/tokens_pb.js";
import { VolumeService } from "../src/gen/toshi/workspace/v1/volumes_pb.js";
import { WebhookService } from "../src/gen/toshi/workspace/v1/webhook_pb.js";
import { WorkspaceService } from "../src/gen/toshi/workspace/v1/workspace_service_pb.js";
import { WorkloadService } from "../src/gen/toshi/workspace/v1/workloads_pb.js";
import { TriggerService } from "../src/gen/toshi/workspace/v1/triggers_pb.js";
import { AccountService } from "../src/gen/toshi/workspace/v1/account_pb.js";
import { ImageService } from "../src/gen/toshi/workspace/v1/images_pb.js";
import { DomainService } from "../src/gen/toshi/workspace/v1/domains_pb.js";
import { retryInterceptor } from "../src/interceptors.js";
import { permission } from "../src/gen/toshi/permission_pb.js";
import { backoffDelay, isTransportLoss, procedurePath, retryClassFor } from "../src/retry.js";
import type { RetryClass, RetryPolicy } from "../src/retry.js";

const fastPolicy: RetryPolicy = { maxAttempts: 3, initialBackoffMs: 5, maxBackoffMs: 20 };

const services: readonly DescService[] = [
  WorkloadService,
  ProjectService,
  SecretService,
  WebhookService,
  DisplayService,
  ChannelService,
  RecordingService,
  VolumeService,
  ArtifactService,
  ArtifactUploadService,
  WorkspaceService,
  HostJobService,
  HostService,
  TokenService,
  AuditEventService,
  FillerService,
  GrantService,
  StorageProviderService,
  ProductService,
  DiscoveryService,
  ConnectionService,
  RoleService,
  TriggerService,
  AccountService,
  ImageService,
  DomainService,
];

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

/**
 * The API's rule: a stream is not retried, a request with a request_key is
 * keyed, and a call whose permission's level is read is a read.
 */
function derivedRetryClass(method: DescMethod): RetryClass {
  if (method.methodKind !== "unary") {
    return "none";
  }
  if (method.input.fields.some((field) => field.name === "request_key")) {
    return "keyed";
  }
  return getOption(method, permission).endsWith(".read") ? "read" : "none";
}

/**
 * The entries that depart from the rule, each because a retry would answer
 * with an error after the first try worked; src/retry.ts says why on the entry.
 */
const retryExceptions: Readonly<Record<string, RetryClass>> = {
  "/toshi.workspace.v1.DisplayService/OpenDisplaySession": "none",
  "/toshi.workspace.v1.AccountService/UnlinkIdentity": "none",
  "/toshi.workspace.v1.RoleService/AcceptInvitation": "none",
};

describe("the retry table", () => {
  it("gives every method of the twenty-six services the class the API's rule gives it", () => {
    const paths = new Set<string>();
    for (const service of services) {
      for (const method of service.methods) {
        const path = procedurePath(service, method);
        expect(paths.has(path), `${path} is listed twice`).toBe(false);
        paths.add(path);
        const expected = retryExceptions[path] ?? derivedRetryClass(method);
        expect(retryClassFor(path), `${path} follows the API's rule`).toBe(expected);
      }
    }
    expect(paths.size).toBe(230);
  });

  it("names an exception only for a method the API has", () => {
    const paths = new Set<string>();
    for (const service of services) {
      for (const method of service.methods) {
        paths.add(procedurePath(service, method));
      }
    }
    for (const path of Object.keys(retryExceptions)) {
      expect(paths.has(path), `${path} is no longer a method`).toBe(true);
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
