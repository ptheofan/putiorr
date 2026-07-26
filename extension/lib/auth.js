// Basic-auth encoding shared by the service worker and the options page.
// No chrome.* APIs here so node's test runner can import this file.

// btoa is Latin-1: it throws above U+00FF and silently mangles U+0080-U+00FF,
// so credentials are encoded to UTF-8 bytes first to match what the server decodes.
export function encodeCredentials(username, password) {
  const utf8 = new TextEncoder().encode(`${username}:${password}`);
  return btoa(String.fromCharCode(...utf8));
}
