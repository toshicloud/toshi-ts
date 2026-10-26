import type { DescMethod, DescService } from "@bufbuild/protobuf";

import { ArtifactService, ArtifactUploadService } from "../gen/toshi/workspace/v1/artifacts_pb.js";
import { AuditEventService } from "../gen/toshi/workspace/v1/audit_events_pb.js";
import { ChannelService } from "../gen/toshi/workspace/v1/channels_pb.js";
import { DisplayService } from "../gen/toshi/workspace/v1/display_pb.js";
import { FillerService } from "../gen/toshi/workspace/v1/fillers_pb.js";
import { HostJobService } from "../gen/toshi/workspace/v1/hostjobs_pb.js";
import { HostService } from "../gen/toshi/workspace/v1/hosts_pb.js";
import { ProjectService } from "../gen/toshi/workspace/v1/projects_pb.js";
import { RecordingService } from "../gen/toshi/workspace/v1/recordings_pb.js";
import { SecretService } from "../gen/toshi/workspace/v1/secrets_pb.js";
import { StorageProviderService } from "../gen/toshi/workspace/v1/storage_providers_pb.js";
import { TokenService } from "../gen/toshi/workspace/v1/tokens_pb.js";
import { VolumeService } from "../gen/toshi/workspace/v1/volumes_pb.js";
import { WebhookService } from "../gen/toshi/workspace/v1/webhook_pb.js";
import { WorkloadService } from "../gen/toshi/workspace/v1/workloads_pb.js";
import { WorkspaceService } from "../gen/toshi/workspace/v1/workspace_service_pb.js";

/** The package the fake serves. */
export const apiPackage = "toshi.workspace.v1";

/** Every service of the Workspace API. */
export const apiServices: readonly DescService[] = [
  WorkloadService,
  SecretService,
  ProjectService,
  WebhookService,
  DisplayService,
  ChannelService,
  RecordingService,
  VolumeService,
  ArtifactService,
  ArtifactUploadService,
  AuditEventService,
  FillerService,
  HostJobService,
  HostService,
  TokenService,
  StorageProviderService,
  WorkspaceService,
];

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

/**
 * The methods the fake has no built-in answer for: a test supplies their
 * answer with `on`. Every method of the Workspace API is either answered by
 * the state machine or listed here, and the coverage test fails when one is
 * neither, so a new method is a decision and not a surprise at a caller.
 */
export const hookOnly: readonly DescMethod[] = [
  // WorkloadService
  WorkloadService.method.updateJob,
  WorkloadService.method.deleteJob,
  WorkloadService.method.updateSandbox,
  WorkloadService.method.deleteSandbox,
  WorkloadService.method.cancelExecution,
  WorkloadService.method.watchTelemetry,
  WorkloadService.method.watchGuestLog,
  WorkloadService.method.createPreviewShareLink,
  WorkloadService.method.listPreviewShareLinks,
  WorkloadService.method.revokePreviewShareLink,
  WorkloadService.method.createService,
  WorkloadService.method.getService,
  WorkloadService.method.listServices,
  WorkloadService.method.updateService,
  WorkloadService.method.deleteService,
  WorkloadService.method.waitService,
  WorkloadService.method.watchServices,
  WorkloadService.method.startService,
  WorkloadService.method.stopService,
  WorkloadService.method.setServiceMode,
  WorkloadService.method.wakeService,
  WorkloadService.method.holdService,
  WorkloadService.method.releaseService,
  WorkloadService.method.listServiceRuns,
  WorkloadService.method.listEvents,
  WorkloadService.method.watchEvents,
  WorkloadService.method.getOperation,
  WorkloadService.method.waitOperation,
  // SecretService
  SecretService.method.createSecretSet,
  SecretService.method.listSecretSets,
  SecretService.method.deleteSecretSet,
  SecretService.method.putSecret,
  SecretService.method.deleteSecret,
  SecretService.method.listSecrets,
  SecretService.method.listSecretVersions,
  SecretService.method.grantSecretSet,
  SecretService.method.revokeSecretSet,
  SecretService.method.listSecretSetGrants,
  // ProjectService
  ProjectService.method.listProjects,
  ProjectService.method.getProject,
  ProjectService.method.listRepositories,
  ProjectService.method.createProject,
  ProjectService.method.claimRepository,
  ProjectService.method.createEnvironment,
  ProjectService.method.deleteEnvironment,
  ProjectService.method.listBranchRules,
  ProjectService.method.setBranchRules,
  ProjectService.method.createEmbedToken,
  ProjectService.method.listEmbedTokens,
  ProjectService.method.revokeEmbedToken,
  // WebhookService
  WebhookService.method.createWebhookEndpoint,
  WebhookService.method.getWebhookEndpoint,
  WebhookService.method.listWebhookEndpoints,
  WebhookService.method.updateWebhookEndpoint,
  WebhookService.method.deleteWebhookEndpoint,
  WebhookService.method.rotateWebhookEndpointSecret,
  WebhookService.method.listWebhookDeliveries,
  WebhookService.method.replayWebhookEvents,
  // DisplayService
  DisplayService.method.openDisplaySession,
  DisplayService.method.getDisplaySession,
  DisplayService.method.listDisplaySessions,
  DisplayService.method.closeDisplaySession,
  DisplayService.method.sendDisplayKeys,
  DisplayService.method.sendDisplayPointer,
  DisplayService.method.setDisplayClipboard,
  DisplayService.method.takeDisplayScreenshot,
  // ChannelService
  ChannelService.method.createChannel,
  ChannelService.method.listChannels,
  ChannelService.method.getChannel,
  ChannelService.method.getChannelPolicy,
  ChannelService.method.setChannelPolicy,
  ChannelService.method.listChannelRequests,
  ChannelService.method.getChannelRequest,
  ChannelService.method.exportChannelLog,
  ChannelService.method.createChannelConnectToken,
  ChannelService.method.revokeChannelConnectToken,
  ChannelService.method.deleteChannel,
  ChannelService.method.listForwards,
  ChannelService.method.getLink,
  // RecordingService
  RecordingService.method.listRecordings,
  RecordingService.method.getRecording,
  RecordingService.method.createRecordingShareLink,
  RecordingService.method.listRecordingShareLinks,
  RecordingService.method.revokeRecordingShareLink,
  // VolumeService
  VolumeService.method.listVolumes,
  VolumeService.method.attachVolume,
  VolumeService.method.detachVolume,
  // ArtifactService
  ArtifactService.method.listArtifacts,
  ArtifactService.method.getArtifact,
  ArtifactService.method.getArtifactDownloadURL,
  // ArtifactUploadService
  ArtifactUploadService.method.reserveUpload,
  ArtifactUploadService.method.completeUpload,
  // AuditEventService
  AuditEventService.method.listAuditEvents,
  // FillerService
  FillerService.method.listFillers,
  FillerService.method.putFiller,
  FillerService.method.deleteFiller,
  FillerService.method.setFillerEnabled,
  FillerService.method.listFillerRuns,
  // HostJobService
  HostJobService.method.listHostJobs,
  HostJobService.method.getHostJob,
  HostJobService.method.cancelHostJob,
  HostJobService.method.getHostJobFailure,
  HostJobService.method.getHostJobTelemetry,
  HostJobService.method.getHostJobDebugAccess,
  HostJobService.method.stopHostJobDebug,
  // HostService
  HostService.method.listHosts,
  HostService.method.listHostStorage,
  HostService.method.listHostAlerts,
  HostService.method.setHostState,
  HostService.method.retireHost,
  HostService.method.createCloudHost,
  HostService.method.checkCloudHost,
  HostService.method.createEnrollmentToken,
  // TokenService
  TokenService.method.listTokens,
  TokenService.method.createWorkspaceToken,
  TokenService.method.revokeToken,
  // StorageProviderService
  StorageProviderService.method.listStorageProviders,
  StorageProviderService.method.createStorageProvider,
  StorageProviderService.method.checkStorageProvider,
  StorageProviderService.method.deleteStorageProvider,
  // WorkspaceService
  WorkspaceService.method.getWorkspace,
  WorkspaceService.method.listWorkspaces,
  WorkspaceService.method.getWorkspaceBilling,
  WorkspaceService.method.getWorkspaceStatement,
  WorkspaceService.method.setWorkspaceOwnHostsOnly,
  WorkspaceService.method.setWorkspaceAllowOverflow,
  WorkspaceService.method.setWorkspaceAllowCacheWarm,
  WorkspaceService.method.setWorkspaceCancelRunOnVmDeath,
  WorkspaceService.method.setWorkspaceSpendLimits,
  WorkspaceService.method.listEgressIPs,
  WorkspaceService.method.getUsage,
  WorkspaceService.method.getQueueTimes,
  WorkspaceService.method.getWorkflowUsage,
  WorkspaceService.method.listPlans,
  WorkspaceService.method.createCheckoutSession,
  WorkspaceService.method.createBillingPortalSession,
  WorkspaceService.method.getVersion,
];
