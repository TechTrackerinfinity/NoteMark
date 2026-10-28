// The Android host exposes only structured Mira API operations to the packaged page.
export const androidNative = typeof globalThis.MiraAndroid?.postMessage === 'function';
export const desktopNative = typeof globalThis.miraDesktop?.request === 'function';
const pending = new Map();
if (androidNative) globalThis.addEventListener('mira-native-result', event => {
  const result = event.detail, item = pending.get(result?.id);
  if (!item) return;
  pending.delete(result.id); clearTimeout(item.timer);
  if (result.error) { const error = new Error(result.error); error.code = result.code; if (result.code === 'timeout') error.name = 'TimeoutError'; item.reject(error); }
  else item.resolve(result.value);
});
export function nativeCall(op, args = {}) {
  if (!androidNative) return Promise.reject(new Error('This feature needs the Android app.'));
  if (pending.size >= 24) return Promise.reject(new Error('Please wait for the current connection to finish.'));
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new DOMException('Android connection timed out', 'TimeoutError')); }, 35000);
    pending.set(id, { resolve, reject, timer });
    try { globalThis.MiraAndroid.postMessage(JSON.stringify({ id, op, args })); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}
export async function nativeFetch(url, options) {
  const args = { url, method: options.method, token: options.headers.Authorization?.slice(7) || '', body: options.body || '', notebook: options.notebook || '', fingerprint: options.fingerprint || '' };
  const result = await (desktopNative ? globalThis.miraDesktop.request(args) : nativeCall('request', args));
  return { status: result.status, ok: result.status >= 200 && result.status < 300, json: async () => result.data };
}
