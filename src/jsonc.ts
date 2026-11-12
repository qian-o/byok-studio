import { isDeepStrictEqual } from 'node:util';
import { applyEdits, getNodeValue, modify, parseTree, type FormattingOptions, type Node, type ParseError } from 'jsonc-parser';
import { t } from '../resources/shared/i18n.js';
import { groupIdentity, isRecord } from './models';

export interface ParsedOfficialJsonc {
  groups: Record<string, unknown>[];
  bom: string;
  body: string;
}

function checkNoDuplicateProperty(node: Node, keys: ReadonlySet<string>): void {
  const seen = new Set<string>();
  for (const prop of node.children ?? []) {
    const key = prop.children?.[0]?.value as string;
    if (keys.has(key) && seen.has(key)) {
      throw new Error(t('官方模型配置包含重复字段，请先检查该文件。'));
    }
    seen.add(key);
  }
}

export function parseOfficialJsonc(text: string): ParsedOfficialJsonc {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? text.slice(1) : text;
  const errors: ParseError[] = [];
  const root = parseTree(body, errors, { allowTrailingComma: true, allowEmptyContent: false });
  if (errors.length || !root || root.type !== 'array' || root.children?.some(node => node.type !== 'object')) {
    throw new Error(t('官方模型配置必须是有效的 JSONC 对象数组。'));
  }

  const essentialKeys = new Set(['vendor', 'name', 'byokStudioId', 'models']);
  const groups: Record<string, unknown>[] = [];
  const studioIds = new Set<string>();

  for (const node of root.children ?? []) {
    checkNoDuplicateProperty(node, essentialKeys);
    const group = getNodeValue(node);
    if (!isRecord(group)) throw new Error(t('官方模型配置必须是有效的 JSONC 对象数组。'));
    if (Object.hasOwn(group, 'byokStudioId') && group.byokStudioId !== undefined) {
      if (typeof group.byokStudioId !== 'string' || !group.byokStudioId.trim()) {
        throw new Error(t('官方模型配置中的 byokStudioId 无效。'));
      }
      if (studioIds.has(group.byokStudioId)) {
        throw new Error(t('官方模型配置包含重复的 byokStudioId。'));
      }
      studioIds.add(group.byokStudioId);
    }
    groups.push(group);
  }
  return { groups, bom, body };
}

export function listOfficialGroups(text: string): Record<string, unknown>[] {
  return parseOfficialJsonc(text).groups;
}

function detectFormatting(body: string): FormattingOptions {
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  if (/\n\t+\S/.test(body)) {
    return { insertSpaces: false, tabSize: 2, eol };
  }
  const spaceMatch = body.match(/\n( +)\S/);
  const tabSize = spaceMatch && spaceMatch[1]!.length === 4 ? 4 : 2;
  return { insertSpaces: true, tabSize, eol };
}

export function findOfficialGroupIndex(groups: readonly Record<string, unknown>[], targetId: string): number {
  const byStudioId = groups.findIndex(g => g.vendor === 'customendpoint' && g.byokStudioId === targetId);
  if (byStudioId >= 0) return byStudioId;
  return groups.findIndex(g => groupIdentity(g) === targetId);
}

export function upsertOfficialGroup(
  text: string,
  targetId: string,
  nextGroup: Record<string, unknown>
): string {
  const { groups, bom, body } = parseOfficialJsonc(text);
  const index = findOfficialGroupIndex(groups, targetId);
  const nameConflict = groups.some((g, i) => i !== index && g.vendor === 'customendpoint' && g.name === nextGroup.name);
  if (nameConflict) {
    throw new Error(t('官方配置已有同名分组“{0}”，请修改供应商名称后重试。', String(nextGroup.name)));
  }
  if (index >= 0 && isDeepStrictEqual(groups[index], nextGroup)) {
    return text;
  }
  const edits = modify(body, [index >= 0 ? index : -1], nextGroup, { formattingOptions: detectFormatting(body) });
  return bom + applyEdits(body, edits);
}

export function removeOfficialGroup(text: string, targetId: string): string {
  const { groups, bom, body } = parseOfficialJsonc(text);
  const index = findOfficialGroupIndex(groups, targetId);
  if (index < 0) return text;
  const edits = modify(body, [index], undefined, { formattingOptions: detectFormatting(body) });
  return bom + applyEdits(body, edits);
}
