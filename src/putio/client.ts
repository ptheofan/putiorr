import type { DbScalar, PutioFile, PutioTransfer } from '../types.ts';

const DEFAULT_BASE_URL = 'https://api.put.io/v2';

type ApiValue = DbScalar | ApiRecord | ApiValue[];
interface ApiRecord {
  [key: string]: ApiValue;
}

type PutioRequestOptions = RequestInit & {
  query?: Record<string, DbScalar>;
};

class PutioRequestError extends Error {
  status: number;
  body: ApiRecord;

  constructor(status: number, message: string, body: ApiRecord) {
    super(`put.io ${status}: ${message}`);
    this.status = status;
    this.body = body;
  }
}

function required<T>(value: T | null | undefined | '', name: string): T {
  if (value == null || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function record(value: ApiValue | undefined): ApiRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function recordList(value: ApiValue | undefined): ApiRecord[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const next = record(item);
        return next ? [next] : [];
      })
    : [];
}

function numberOrNull(value: ApiValue | undefined): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: ApiValue | undefined, fallback = ''): string {
  return value == null ? fallback : String(value);
}

function normalizeFile(file?: ApiRecord): PutioFile | undefined {
  if (!file) return undefined;
  return {
    id: numberOrNull(file.id),
    name: stringValue(file.name),
    size: Number(file.size ?? 0),
    parentId: numberOrNull(file.parent_id ?? file.parentId),
    contentType: stringValue(file.content_type ?? file.contentType),
    fileType: stringValue(file.file_type ?? file.fileType),
    isDir: Boolean(
      file.is_dir
      || file.isDir
      || file.file_type === 'FOLDER'
      || file.content_type === 'application/x-directory',
    ),
  };
}

export function normalizeTransfer(transfer?: ApiRecord): PutioTransfer | undefined {
  if (!transfer) return undefined;
  return {
    id: numberOrNull(transfer.id),
    name: stringValue(transfer.name ?? transfer.file_name ?? transfer.url),
    hash: stringValue(transfer.hash ?? transfer.info_hash),
    status: stringValue(transfer.status, 'UNKNOWN'),
    statusMessage: stringValue(transfer.status_message ?? transfer.statusMessage),
    errorMessage: stringValue(transfer.error_message ?? transfer.errorMessage),
    percentDone: Number(transfer.percent_done ?? transfer.percentDone ?? 0),
    completionPercent: Number(transfer.completion_percent ?? transfer.completionPercent ?? 0),
    size: Number(transfer.size ?? 0),
    downloaded: Number(transfer.downloaded ?? 0),
    uploaded: Number(transfer.uploaded ?? 0),
    downloadSpeed: Number(transfer.download_speed ?? transfer.downloadSpeed ?? 0),
    uploadSpeed: Number(transfer.upload_speed ?? transfer.uploadSpeed ?? 0),
    estimatedTime: Number(transfer.estimated_time ?? transfer.estimatedTime ?? -1),
    fileId: numberOrNull(transfer.file_id ?? transfer.fileId),
    saveParentId: numberOrNull(transfer.save_parent_id ?? transfer.saveParentId),
    magnetUri: stringValue(transfer.magneturi ?? transfer.magnet_uri ?? transfer.magnetURI),
  };
}

export class PutioClient {
  token: string;
  baseUrl: string;
  fetch: typeof globalThis.fetch;

  constructor({
    token,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
  }: {
    token?: string;
    baseUrl?: string;
    fetchImpl?: typeof globalThis.fetch | null;
  } = {}) {
    this.token = required(token, 'put.io token');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = required(fetchImpl, 'fetch implementation');
  }

  async request(path: string, options: PutioRequestOptions = {}): Promise<ApiRecord> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value != null) url.searchParams.set(key, String(value));
      }
    }

    const headers = new Headers(options.headers ?? {});
    headers.set('Authorization', `Bearer ${this.token}`);

    const response = await this.fetch(url, {
      ...options,
      headers,
    });

    const text = await response.text();
    const body = text ? JSON.parse(text) as ApiRecord : {};
    if (!response.ok) {
      const message = body.error_message ?? body.error ?? body.message ?? response.statusText;
      throw new PutioRequestError(response.status, String(message), body);
    }
    return body;
  }

  async getAccountInfo(): Promise<ApiRecord> {
    const body = await this.request('/account/info');
    return record(body.info) ?? record(body.account) ?? body;
  }

  async ensureFolder(name: string): Promise<number | null> {
    const files = await this.listFiles(0);
    const existing = files.find((file) => file.isDir && file.name === name);
    if (existing) return existing.id;

    const form = new URLSearchParams();
    form.set('name', name);
    form.set('parent_id', '0');

    const body = await this.request('/files/create-folder', {
      method: 'POST',
      body: form,
    });
    const folder = normalizeFile(record(body.file) ?? body);
    if (!folder?.id) {
      throw new Error('put.io did not return a folder id');
    }
    return folder.id;
  }

  async addTransfer(url: string, folderId: number | null): Promise<PutioTransfer | undefined> {
    const form = new URLSearchParams();
    form.set('url', url);
    form.set('save_parent_id', String(folderId));

    const body = await this.request('/transfers/add', {
      method: 'POST',
      body: form,
    });
    return normalizeTransfer(record(body.transfer) ?? body);
  }

  async uploadTorrent(data: Buffer, filename: string, folderId: number | null): Promise<PutioTransfer | undefined> {
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(data)]), filename);
    form.set('parent_id', String(folderId));

    const body = await this.request('/files/upload', {
      method: 'POST',
      body: form,
    });
    const upload = record(body.upload);
    return normalizeTransfer(record(body.transfer) ?? record(upload?.transfer) ?? body);
  }

  async listTransfers(): Promise<PutioTransfer[]> {
    const body = await this.request('/transfers/list');
    return recordList(body.transfers).map(normalizeTransfer).filter((item) => item !== undefined);
  }

  async retryTransfer(transferId: number): Promise<PutioTransfer | undefined> {
    const form = new URLSearchParams();
    form.set('transfer_ids', String(transferId));
    const body = await this.request('/transfers/retry', {
      method: 'POST',
      body: form,
    });
    return normalizeTransfer(record(body.transfer) ?? recordList(body.transfers)[0] ?? body);
  }

  async deleteTransfer(transferId: number): Promise<void> {
    const form = new URLSearchParams();
    form.set('transfer_ids', String(transferId));
    await this.request('/transfers/cancel', {
      method: 'POST',
      body: form,
    });
  }

  async listFiles(parentId: number | null): Promise<PutioFile[]> {
    const body = await this.request('/files/list', {
      query: { parent_id: parentId },
    });
    return recordList(body.files).map(normalizeFile).filter((item) => item !== undefined);
  }

  async getFile(fileId: number | null): Promise<PutioFile | undefined> {
    const body = await this.request(`/files/${fileId}`);
    return normalizeFile(record(body.file) ?? body);
  }

  async listTransferFiles(fileId: number | null): Promise<PutioFile[]> {
    const root = await this.getFile(fileId);
    if (!root) return [];
    if (!root.isDir) {
      return [{ ...root, relativePath: root.name }];
    }

    const files: PutioFile[] = [];
    const visit = async (parentId: number | null, prefix = ''): Promise<void> => {
      const children = await this.listFiles(parentId);
      for (const child of children) {
        const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
        if (child.isDir) {
          await visit(child.id, relativePath);
        } else {
          files.push({ ...child, relativePath });
        }
      }
    };
    await visit(root.id);
    return files;
  }

  async getDownloadUrl(fileId: number | null): Promise<string> {
    const body = await this.request(`/files/${fileId}/url`);
    return String(body.url ?? body.download_url ?? body.downloadUrl ?? '');
  }

  async deleteFile(fileId: number | null): Promise<void> {
    const form = new URLSearchParams();
    form.set('file_ids', String(fileId));
    await this.request('/files/delete', {
      method: 'POST',
      body: form,
    });
  }
}
