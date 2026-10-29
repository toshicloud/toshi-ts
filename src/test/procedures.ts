import type { DescMethod, DescService } from "@bufbuild/protobuf";

import { AccountService } from "../gen/toshi/workspace/v1/account_pb.js";
import { ArtifactService, ArtifactUploadService } from "../gen/toshi/workspace/v1/artifacts_pb.js";
import { AuditEventService } from "../gen/toshi/workspace/v1/audit_events_pb.js";
import { ChannelService } from "../gen/toshi/workspace/v1/channels_pb.js";
import { DisplayService } from "../gen/toshi/workspace/v1/display_pb.js";
import { DomainService } from "../gen/toshi/workspace/v1/domains_pb.js";
import { FillerService } from "../gen/toshi/workspace/v1/fillers_pb.js";
import { GrantService } from "../gen/toshi/workspace/v1/grants_pb.js";
import { HostJobService } from "../gen/toshi/workspace/v1/hostjobs_pb.js";
import { HostService } from "../gen/toshi/workspace/v1/hosts_pb.js";
import { ImageService } from "../gen/toshi/workspace/v1/images_pb.js";
import { ProductService } from "../gen/toshi/workspace/v1/products_pb.js";
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
  GrantService,
  HostJobService,
  HostService,
  TokenService,
  StorageProviderService,
  WorkspaceService,
  AccountService,
  ImageService,
  ProductService,
  DomainService,
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
  // AccountService
  AccountService.method.getAccount,
  AccountService.method.listIdentities,
  AccountService.method.unlinkIdentity,
  // ImageService
  ImageService.method.createImage,
  ImageService.method.buildImage,
  ImageService.method.getImage,
  ImageService.method.listImages,
  ImageService.method.deleteImage,
  ImageService.method.updateImage,
  // ProductService
  ProductService.method.listProducts,
  ProductService.method.updateProduct,
  // WorkloadService
  WorkloadService.method.updateJob,
  WorkloadService.method.deleteJob,
  WorkloadService.method.updateSandbox,
  WorkloadService.method.deleteSandbox,
  WorkloadService.method.stopSandbox,
  WorkloadService.method.startSandbox,
  WorkloadService.method.cancelExecution,
  WorkloadService.method.exportEvents,
  WorkloadService.method.watchTelemetry,
  WorkloadService.method.watchGuestLog,
  WorkloadService.method.createPreviewShareLink,
  WorkloadService.method.listPreviewShareLinks,
  WorkloadService.method.revokePreviewShareLink,
  WorkloadService.method.createServiceShareLink,
  WorkloadService.method.listServiceShareLinks,
  WorkloadService.method.revokeServiceShareLink,
  WorkloadService.method.executeCommand,
  WorkloadService.method.answerPrompt,
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
  WorkloadService.method.listServiceRevisions,
  WorkloadService.method.getServiceRevision,
  WorkloadService.method.rollbackService,
  WorkloadService.method.listServiceActivations,
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
  ProjectService.method.updateProject,
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
  ProjectService.method.getProjectNetwork,
  ProjectService.method.setProjectNetwork,
  ProjectService.method.getEnvironmentNetwork,
  ProjectService.method.setEnvironmentNetwork,
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
  ChannelService.method.sendChannelMessage,
  ChannelService.method.tailChannelMessages,
  ChannelService.method.replayChannelMessage,
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
  VolumeService.method.listVolumeVersions,
  VolumeService.method.restoreVolume,
  // ArtifactService
  ArtifactService.method.listArtifacts,
  ArtifactService.method.getArtifact,
  ArtifactService.method.getArtifactDownloadURL,
  // ArtifactUploadService
  ArtifactUploadService.method.reserveUpload,
  ArtifactUploadService.method.completeUpload,
  // AuditEventService
  AuditEventService.method.listAuditEvents,
  AuditEventService.method.exportAuditEvents,
  // FillerService
  FillerService.method.listFillers,
  FillerService.method.putFiller,
  FillerService.method.deleteFiller,
  FillerService.method.setFillerEnabled,
  FillerService.method.listFillerRuns,
  // GrantService
  GrantService.method.createGrant,
  GrantService.method.getGrant,
  GrantService.method.listGrants,
  GrantService.method.acceptGrant,
  GrantService.method.declineGrant,
  GrantService.method.updateGrant,
  GrantService.method.revokeGrant,
  GrantService.method.leaveGrant,
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
  TokenService.method.rollWorkspaceToken,
  TokenService.method.updateToken,
  // StorageProviderService
  StorageProviderService.method.listStorageProviders,
  StorageProviderService.method.createStorageProvider,
  StorageProviderService.method.checkStorageProvider,
  StorageProviderService.method.deleteStorageProvider,
  // WorkspaceService
  WorkspaceService.method.getWorkspace,
  WorkspaceService.method.updateWorkspace,
  WorkspaceService.method.listWorkspaces,
  WorkspaceService.method.getWorkspaceBilling,
  WorkspaceService.method.getWorkspaceStatement,
  WorkspaceService.method.listEgressIPs,
  WorkspaceService.method.getUsage,
  WorkspaceService.method.getQueueTimes,
  WorkspaceService.method.getWorkflowUsage,
  WorkspaceService.method.listPlans,
  WorkspaceService.method.createCheckoutSession,
  WorkspaceService.method.createBillingPortalSession,
  WorkspaceService.method.getVersion,
  // DomainService
  DomainService.method.createDomain,
  DomainService.method.getDomain,
  DomainService.method.listDomains,
  DomainService.method.verifyDomain,
  DomainService.method.issueDomain,
  DomainService.method.deleteDomain,
];
