import type { ApiType } from './types';
import { t } from '../../resources/shared/i18n.js';

/** Accept an origin, a prefixed API root, or an existing API operation URL. */
export function resolveEndpoint(baseUrl: string, apiType: ApiType, operation: 'chat' | 'models'): string {
  if (!['responses', 'chatCompletions', 'messages'].includes(apiType) || !['chat', 'models'].includes(operation)) throw new Error(t('不支持的 API 操作。'));
  let url: URL;
  try { url = new URL(baseUrl.trim()); } catch { throw new Error(t('服务商 URL 无效。')); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(t('服务商 URL 必须使用 HTTP 或 HTTPS，且不能包含凭据。'));
  let path = url.pathname.replace(/\/+$/, '');
  const endpoint = /\/(?:chat\/completions|responses|messages|models)$/;
  if (endpoint.test(path)) path = path.replace(endpoint, '');
  else if (!/(?:^|\/)v\d+(?:[a-z][\w.-]*)?(?:\/|$)/i.test(path)) path += '/v1';
  const suffix = operation === 'models' ? 'models' : { responses: 'responses', chatCompletions: 'chat/completions', messages: 'messages' }[apiType];
  url.pathname = `${path}/${suffix}`;
  url.hash = '';
  return url.toString();
}
