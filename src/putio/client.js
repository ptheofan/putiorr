const DEFAULT_BASE_URL = 'https://api.put.io/v2';

function required(value, name) {
  if (value == null || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeFile(file) {
  if (!file) return undefined;
  return {
    id: numberOrNull(file.id),
    name: file.name ?? '',
    size: Number(file.size ?? 0),
    parentId: numberOrNull(file.parent_id ?? file.parentId),
    contentType: file.content_type ?? file.contentType ?? '',
    fileType: file.file_type ?? file.fileType ?? '',
    isDir: Boolean(
      file.is_dir
      || file.isDir
      || file.file_type === 'FOLDER'
      || file.content_type === 'application/x-directory',
    ),
  };
}

export function normalizeTransfer(transfer) {
  if (!transfer) return undefined;
  return {
    id: numberOrNull(transfer.id),
    name: transfer.name ?? transfer.file_name ?? transfer.url ?? '',
    hash: transfer.hash ?? transfer.info_hash ?? '',
    status: transfer.status ?? 'UNKNOWN',
    statusMessage: transfer.status_message ?? transfer.statusMessage ?? '',
    errorMessage: transfer.error_message ?? transfer.errorMessage ?? '',
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
    magnetUri: transfer.magneturi ?? transfer.magnet_uri ?? transfer.magnetURI ?? '',
  };
}

export class PutioClient {
  constructor({ token, baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
    this.token = required(token, 'put.io token');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = required(fetchImpl, 'fetch implementation');
  }

  async request(path, options = {}) {
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
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message = body.error_message ?? body.error ?? body.message ?? response.statusText;
      const error = new Error(`put.io ${response.status}: ${message}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  async getAccountInfo() {
    const body = await this.request('/account/info');
    return body.info ?? body.account ?? body;
  }

  async ensureFolder(name) {
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
    const folder = normalizeFile(body.file ?? body);
    if (!folder?.id) {
      throw new Error('put.io did not return a folder id');
    }
    return folder.id;
  }

  async addTransfer(url, folderId) {
    const form = new URLSearchParams();
    form.set('url', url);
    form.set('save_parent_id', String(folderId));

    const body = await this.request('/transfers/add', {
      method: 'POST',
      body: form,
    });
    return normalizeTransfer(body.transfer ?? body);
  }

  async uploadTorrent(data, filename, folderId) {
    const form = new FormData();
    form.set('file', new Blob([data]), filename);
    form.set('parent_id', String(folderId));

    const body = await this.request('/files/upload', {
      method: 'POST',
      body: form,
    });
    return normalizeTransfer(body.transfer ?? body.upload?.transfer ?? body);
  }

  async listTransfers() {
    const body = await this.request('/transfers/list');
    return (body.transfers ?? []).map(normalizeTransfer).filter(Boolean);
  }

  async retryTransfer(transferId) {
    const form = new URLSearchParams();
    form.set('transfer_ids', String(transferId));
    const body = await this.request('/transfers/retry', {
      method: 'POST',
      body: form,
    });
    return normalizeTransfer(body.transfer ?? body.transfers?.[0] ?? body);
  }

  async deleteTransfer(transferId) {
    const form = new URLSearchParams();
    form.set('transfer_ids', String(transferId));
    await this.request('/transfers/cancel', {
      method: 'POST',
      body: form,
    });
  }

  async listFiles(parentId) {
    const body = await this.request('/files/list', {
      query: { parent_id: parentId },
    });
    return (body.files ?? []).map(normalizeFile).filter(Boolean);
  }

  async getFile(fileId) {
    const body = await this.request(`/files/${fileId}`);
    return normalizeFile(body.file ?? body);
  }

  async listTransferFiles(fileId) {
    const root = await this.getFile(fileId);
    if (!root) return [];
    if (!root.isDir) {
      return [{ ...root, relativePath: root.name }];
    }

    const files = [];
    const visit = async (parentId, prefix = '') => {
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

  async getDownloadUrl(fileId) {
    const body = await this.request(`/files/${fileId}/url`);
    return body.url ?? body.download_url ?? body.downloadUrl;
  }

  async deleteFile(fileId) {
    const form = new URLSearchParams();
    form.set('file_ids', String(fileId));
    await this.request('/files/delete', {
      method: 'POST',
      body: form,
    });
  }
}
