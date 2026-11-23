/** Native HTTP for the phone backend (no CORS, custom headers such as User-Agent are allowed). */
import { CapacitorHttp } from '@capacitor/core';
import type { Http } from './online';

/**
 * The query string is built here with encodeURIComponent (UTF-8): the native layers encode Cyrillic and "+" each
 * in their own way (iOS keeps "+" as is, so "a+b" became "a b"), which broke Russian queries now and then.
 */
export const withQuery = (url: string, params?: Record<string, string>) => {
  if (!params) return url;
  const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return qs ? url + (url.includes('?') ? '&' : '?') + qs : url;
};
const JSON_UTF8 = 'application/json; charset=utf-8';
const fixHeaders = (h?: Record<string, string>) => {
  if (!h) return { 'Content-Type': JSON_UTF8 };
  const out = { ...h };
  for (const k of Object.keys(out)) if (k.toLowerCase() === 'content-type' && /json/.test(out[k])) out[k] = JSON_UTF8;
  return out;
};

export const H: Http = {
  get: (url, params, headers) => CapacitorHttp.get({ url: withQuery(url, params), headers, connectTimeout: 8000, readTimeout: 10000, shouldEncodeUrlParams: false }),
  post: (url, data, headers) => CapacitorHttp.post({ url, data, headers: fixHeaders(headers), connectTimeout: 8000, readTimeout: 10000 }),
};

/** Binary GET (downloads on iPhone): the native layer returns the body as base64. */
export async function getBytes(url: string, headers?: Record<string, string>, timeout = 30000): Promise<{ status: number; b64: string; headers: Record<string, string> }> {
  const r = await CapacitorHttp.get({ url, headers, responseType: 'arraybuffer', connectTimeout: 12000, readTimeout: timeout, shouldEncodeUrlParams: false });
  return { status: r.status, b64: typeof r.data === 'string' ? r.data : '', headers: r.headers ?? {} };
}
