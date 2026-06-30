const DEFAULT_OAUTH_BASE_URL = 'https://api.put.io/v2/oauth2/oob';
const DEFAULT_OAUTH_AUTHORIZE_URL = 'https://api.put.io/v2/oauth2/authenticate';

type OAuthRecord = Record<string, string | number | boolean | null | undefined>;

export class PutioOAuthClient {
  appId: string;
  baseUrl: string;
  authorizeUrl: string;
  fetch: typeof globalThis.fetch;

  constructor({
    appId,
    baseUrl = DEFAULT_OAUTH_BASE_URL,
    authorizeUrl = DEFAULT_OAUTH_AUTHORIZE_URL,
    fetchImpl = globalThis.fetch,
  }: {
    appId?: string;
    baseUrl?: string;
    authorizeUrl?: string;
    fetchImpl?: typeof globalThis.fetch | null;
  } = {}) {
    if (!appId) throw new Error('put.io OAuth app id is required');
    if (!fetchImpl) throw new Error('fetch implementation is required');
    this.appId = appId;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.authorizeUrl = authorizeUrl;
    this.fetch = fetchImpl;
  }

  startRedirect({ redirectUri, state }: { redirectUri?: string; state?: string } = {}) {
    if (!redirectUri) throw new Error('OAuth redirect URI is required');
    if (!state) throw new Error('OAuth state is required');
    const url = new URL(this.authorizeUrl);
    url.searchParams.set('client_id', this.appId);
    url.searchParams.set('response_type', 'token');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return {
      authUrl: url.toString(),
      putioRedirectUri: redirectUri,
    };
  }

  async start(): Promise<{ code: string; qrCodeUrl: string; linkUrl: string }> {
    const url = new URL(`${this.baseUrl}/code`);
    url.searchParams.set('app_id', this.appId);
    const body = await this.request(url);
    return {
      code: String(body.code ?? ''),
      qrCodeUrl: String(body.qr_code_url ?? body.qrCodeUrl ?? ''),
      linkUrl: 'https://put.io/link',
    };
  }

  async poll(code: string): Promise<{ status: string; oauthToken: string }> {
    if (!code) throw new Error('OAuth code is required');
    const url = new URL(`${this.baseUrl}/code/${encodeURIComponent(code)}`);
    const body = await this.request(url);
    return {
      status: String(body.status ?? 'UNKNOWN'),
      oauthToken: String(body.oauth_token ?? body.oauthToken ?? ''),
    };
  }

  async request(url: URL): Promise<OAuthRecord> {
    const response = await this.fetch(url);
    const text = await response.text();
    const body = text ? JSON.parse(text) as OAuthRecord : {};
    if (!response.ok) {
      const message = body.error_message ?? body.error ?? body.message ?? response.statusText;
      throw new Error(`put.io OAuth ${response.status}: ${message}`);
    }
    return body;
  }
}
