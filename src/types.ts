export type DbScalar = string | number | boolean | null | undefined;
export type DbPatch = Record<string, DbScalar>;

export interface DownloadPolicy {
  slowSpeedThresholdBytesPerSecond: number;
  slowSpeedDurationSeconds: number;
  slowSpeedGraceSeconds: number;
  slowSpeedMinSizeBytes: number;
}

export interface DownloadPolicyInput {
  slowSpeedThresholdBytesPerSecond?: DbScalar;
  slowSpeedDurationSeconds?: DbScalar;
  slowSpeedGraceSeconds?: DbScalar;
  slowSpeedMinSizeBytes?: DbScalar;
  slow_speed_threshold_bytes_per_second?: DbScalar;
  slow_speed_duration_seconds?: DbScalar;
  slow_speed_grace_seconds?: DbScalar;
  slow_speed_min_size_bytes?: DbScalar;
}

export interface AppConfig extends DownloadPolicy {
  appName: string;
  targetDir: string;
  statePath: string;
  listenHost: string;
  listenPort: number;
  putioToken: string;
  putioAppId: string;
  publicUrl: string;
  putioOAuthRelayUrl: string;
  putioFolder: string;
  defaultProfileName: string;
  defaultProfileType: string;
  defaultRpcPath: string;
  seedProfiles: ProfileInput[];
  workers: number;
  pollIntervalMs: number;
  cleanupRemoteFiles: boolean;
  rpcUsername: string;
  rpcPassword: string;
  refreshOnRpc: boolean;
  liveReload: boolean;
}

export interface DownloadProfile extends DownloadPolicy {
  id: number;
  name: string;
  slug: string;
  slow_speed_threshold_bytes_per_second: number;
  slow_speed_duration_seconds: number;
  slow_speed_grace_seconds: number;
  slow_speed_min_size_bytes: number;
  created_at: string;
  updated_at: string;
}

export interface DownloadProfileInput extends DownloadPolicyInput {
  name?: string;
  slug?: string;
  downloadPolicy?: DownloadPolicyInput;
}

export interface Profile {
  id: number;
  name: string;
  type: string;
  slug: string;
  download_profile_id: number | null;
  downloadProfileId: number | null;
  putio_folder_name: string;
  putio_folder_id: number | null;
  download_at: string;
  downloadAt: string;
  rpc_path: string;
  client_host: string;
  clientHost: string;
  client_port: string;
  clientPort: string;
  client_use_ssl: boolean;
  clientUseSsl: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProfileInput {
  id?: number;
  name?: string;
  type?: string;
  slug?: string;
  download_profile_id?: DbScalar;
  downloadProfileId?: DbScalar;
  putio_folder_name?: string;
  putioFolderName?: string;
  putio_folder_id?: DbScalar;
  putioFolderId?: DbScalar;
  download_at?: string;
  downloadAt?: string;
  local_path?: string;
  localPath?: string;
  rpc_path?: string;
  rpcPath?: string;
  client_host?: string;
  clientHost?: string;
  client_port?: string;
  clientPort?: string;
  client_use_ssl?: DbScalar;
  clientUseSsl?: DbScalar;
  enabled?: boolean;
}

export interface Transfer {
  id: number;
  profile_id: number | null;
  putio_transfer_id: number | null;
  putio_file_id: number | null;
  save_parent_id: number | null;
  hash: string;
  name: string;
  source: string;
  source_type: string;
  category: string;
  download_dir: string;
  lifecycle: string;
  putio_status: string;
  percent_done: number;
  completion_percent: number;
  total_size: number;
  downloaded_ever: number;
  uploaded_ever: number;
  download_speed: number;
  upload_speed: number;
  eta: number;
  error: boolean;
  error_string: string;
  retry_count: number;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TransferInput extends Partial<Transfer> {
  size?: number;
}

export interface TransferFile {
  id: number;
  transfer_id: number;
  putio_file_id: number;
  relative_path: string;
  size: number;
  downloaded_bytes: number;
  download_speed: number;
  status: string;
  attempts: number;
  error_string: string;
  created_at: string;
  updated_at: string;
  category?: string;
  transfer_name?: string;
  transfer_hash?: string;
}

export interface TransferFileInput extends Partial<TransferFile> {
  transfer_id: number;
  putio_file_id: number;
  relative_path: string;
}

export interface TransferFileStats {
  total_files: number;
  completed_files: number;
  failed_files: number;
  total_size: number;
  downloaded_size: number;
}

export interface RemovedTransfer {
  id: number;
  putio_transfer_id: number | null;
  hash: string;
}

export interface PutioTransfer {
  id: number | null;
  name: string;
  hash: string;
  status: string;
  statusMessage: string;
  errorMessage: string;
  percentDone: number;
  completionPercent: number;
  size: number;
  downloaded: number;
  uploaded: number;
  downloadSpeed: number;
  uploadSpeed: number;
  estimatedTime: number;
  fileId: number | null;
  saveParentId: number | null;
  magnetUri: string;
}

export interface PutioFile {
  id: number | null;
  name: string;
  size: number;
  parentId: number | null;
  contentType: string;
  fileType: string;
  isDir: boolean;
  relativePath?: string;
}

export interface PutioClientLike {
  getAccountInfo(): Promise<Record<string, DbScalar | object>>;
  ensureFolder(name: string): Promise<number | null>;
  addTransfer(url: string, folderId: number | null): Promise<PutioTransfer | undefined>;
  uploadTorrent(data: Buffer, filename: string, folderId: number | null): Promise<PutioTransfer | undefined>;
  listTransfers(): Promise<PutioTransfer[]>;
  retryTransfer(transferId: number): Promise<PutioTransfer | undefined>;
  deleteTransfer(transferId: number): Promise<void>;
  listFiles(parentId: number | null): Promise<PutioFile[]>;
  getFile(fileId: number | null): Promise<PutioFile | undefined>;
  listTransferFiles(fileId: number | null): Promise<PutioFile[]>;
  getDownloadUrl(fileId: number | null): Promise<string>;
  deleteFile(fileId: number | null): Promise<void>;
}
