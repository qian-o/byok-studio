import { createScanner, getNodeValue, parseTree, SyntaxKind, type Node, type ParseError } from 'jsonc-parser';
import { t } from '../../resources/shared/i18n.js';

export interface ParsedNativeGroups {
  groups: Record<string, unknown>[];
  /** Offsets refer to the original text, including an optional UTF-8 BOM. */
  root: Node;
}

export interface OwnedGroupUpdateOptions {
  /** Top-level fields to delete after merging. Required identity fields cannot be removed. */
  removeFields?: readonly string[];
  /** Managed model fields are replaced, while all other per-model fields are retained. */
  managedModelFields?: readonly string[];
  /** Replace selected owned top-level values after the caller has retained their unrelated properties. */
  replaceFields?: readonly string[];
}

export interface OwnedGroupChange extends OwnedGroupUpdateOptions {
  providerId: string;
  group: Record<string, unknown> | null;
}

const essentialKeys = new Set(['vendor', 'name', 'byokStudioId', 'providerId', 'byokStudioGroupName', 'models']);
const requiredKeys = new Set(['vendor', 'name', 'byokStudioId']);
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function checkProviderId(providerId: string): void {
  if (typeof providerId !== 'string' || !providerId.trim()) {
    throw new Error(t('必须提供非空的 BYOK Studio 供应商 ID。'));
  }
}

function checkDuplicateKeys(node: Node, keys?: ReadonlySet<string>): void {
  const seen = new Set<string>();
  for (const property of node.children ?? []) {
    const key = property.children?.[0]?.value as string;
    if ((!keys || keys.has(key)) && seen.has(key)) {
      throw new Error(t('重复的键使原生模型配置存在歧义。'));
    }
    seen.add(key);
  }
}

function checkOwnedTree(node: Node): void {
  if (node.type === 'object') { checkDuplicateKeys(node); }
  for (const child of node.children ?? []) { checkOwnedTree(child); }
}

function modelsById(value: unknown): Map<string, Record<string, unknown>> {
  if (!Array.isArray(value)) { throw new Error(t('托管模型必须是数组。')); }
  const result = new Map<string, Record<string, unknown>>();
  for (const model of value) {
    if (!isRecord(model) || typeof model.id !== 'string' || !model.id.trim()) {
      throw new Error(t('每个托管模型必须具有非空的字符串 ID。'));
    }
    if (result.has(model.id)) { throw new Error(t('重复的托管模型 ID 存在歧义。')); }
    result.set(model.id, model);
  }
  return result;
}

function checkOwnedGroup(group: Record<string, unknown>, providerId: string): void {
  if (group.byokStudioId !== providerId || group.vendor !== 'customendpoint') {
    throw new Error(t('托管分组需要匹配的 byokStudioId，且 vendor 必须为 customendpoint。'));
  }
  if (typeof group.name !== 'string' || !group.name.trim()) {
    throw new Error(t('托管分组需要非空的名称。'));
  }
  if (own(group, 'models')) { modelsById(group.models); }
}

/** Parse without repairing input. Only object elements are accepted; unrelated vendor schemas are opaque. */
export function parseNativeGroups(text: string): ParsedNativeGroups {
  const errors: ParseError[] = [];
  const source = text.startsWith('\uFEFF') ? ` ${text.slice(1)}` : text;
  const root = parseTree(source, errors, { allowTrailingComma: true, allowEmptyContent: false });
  if (errors.length || !root || root.type !== 'array' || root.children?.some(node => node.type !== 'object')) {
    throw new Error(t('原生模型配置必须是有效的 JSONC 对象数组。'));
  }
  const groups: Record<string, unknown>[] = [];
  const markers = new Set<string>();
  for (const node of root.children ?? []) {
    checkDuplicateKeys(node, essentialKeys);
    const models = node.children?.find(property => property.children?.[0]?.value === 'models')?.children?.[1];
    for (const model of models?.type === 'array' ? models.children ?? [] : []) {
      if (model.type === 'object') { checkDuplicateKeys(model, new Set(['id'])); }
    }
    const group = getNodeValue(node) as Record<string, unknown>;
    if (own(group, 'byokStudioId')) {
      const marker = group.byokStudioId;
      if (typeof marker !== 'string') { throw new Error(t('BYOK Studio 所有权标记无效。')); }
      checkProviderId(marker);
      if (markers.has(marker)) { throw new Error(t('重复的 BYOK Studio 所有权标记存在歧义。')); }
      markers.add(marker);
      checkOwnedGroup(group, marker);
    }
    groups.push(group);
  }
  return { groups, root };
}

export function listGroups(text: string): Record<string, unknown>[] {
  return parseNativeGroups(text).groups;
}

export function hasGroupConflict(text: string, name: string, providerId: string): boolean {
  checkProviderId(providerId);
  return parseNativeGroups(text).groups.some(group =>
    group.vendor === 'customendpoint' && group.name === name && group.byokStudioId !== providerId);
}

function cloneJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') { return value; }
  if (typeof value === 'number' && Number.isFinite(value)) { return value; }
  if (!isRecord(value) && !Array.isArray(value)) {
    throw new Error(t('托管分组的值必须是 JSON 值。'));
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error(t('托管分组的值必须是普通 JSON 对象。'));
  }
  if (ancestors.has(value)) { throw new Error(t('托管分组的值不能包含循环引用。')); }
  ancestors.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = Array.from(value, child => cloneJson(child, ancestors));
  } else {
    result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child, ancestors)]));
  }
  ancestors.delete(value);
  return result;
}

function mergeRecords(previous: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    const before = own(previous, key) ? previous[key] : undefined;
    Object.defineProperty(merged, key, {
      value: isRecord(before) && isRecord(value) ? mergeRecords(before, value) : value,
      enumerable: true, writable: true, configurable: true
    });
  }
  return merged;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) { return true; }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) { return false; }
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => own(right, key) && sameJson(left[key], right[key]));
}

function indentAt(text: string, offset: number): string | undefined {
  const start = Math.max(text.lastIndexOf('\n', offset - 1), text.lastIndexOf('\r', offset - 1)) + 1;
  const prefix = text.slice(start, offset);
  return /^[\t ]*$/.test(prefix) ? prefix : undefined;
}

function formatting(text: string, root: Node, target?: Node): { eol: string; unit: string; base: string; rootIndent: string } {
  const eol = text.match(/\r\n|\n|\r/)?.[0] ?? '\n';
  const rootIndent = indentAt(text, root.offset) ?? '';
  const nodes = target ? [target, ...(root.children ?? [])] : root.children ?? [];
  let unit: string | undefined;
  for (const node of nodes) {
    const base = indentAt(text, node.offset);
    for (const property of node.children ?? []) {
      const propertyIndent = indentAt(text, property.offset);
      if (base !== undefined && propertyIndent?.startsWith(base) && propertyIndent.length > base.length) {
        unit = propertyIndent.slice(base.length);
        break;
      }
    }
    if (!unit && base?.startsWith(rootIndent) && base.length > rootIndent.length) {
      unit = base.slice(rootIndent.length);
    }
    if (unit) { break; }
  }
  unit ??= '  ';
  return { eol, unit, base: target ? indentAt(text, target.offset) ?? rootIndent + unit : rootIndent + unit, rootIndent };
}

function formatGroup(group: Record<string, unknown>, style: ReturnType<typeof formatting>): string {
  return JSON.stringify(group, null, '\t').split('\n').map((line, index) => {
    const tabs = line.match(/^\t*/)?.[0].length ?? 0;
    return (index ? style.base : '') + style.unit.repeat(tabs) + line.slice(tabs);
  }).join(style.eol);
}

/** Scan the separator gap so commas inside comments can never be mistaken for array separators. */
function commaBetween(text: string, start: number, end: number): number | undefined {
  const scanner = createScanner(text);
  scanner.setPosition(start);
  for (let token = scanner.scan(); token !== SyntaxKind.EOF && scanner.getTokenOffset() < end; token = scanner.scan()) {
    if (token === SyntaxKind.CommaToken) { return scanner.getTokenOffset(); }
  }
  return undefined;
}

function removeElement(text: string, root: Node, index: number): string {
  const nodes = root.children ?? [];
  const node = nodes[index]!;
  const end = node.offset + node.length;
  let comma = commaBetween(text, end, nodes[index + 1]?.offset ?? root.offset + root.length - 1);
  if (comma === undefined && index > 0) {
    const previous = nodes[index - 1]!;
    comma = commaBetween(text, previous.offset + previous.length, node.offset);
  }
  // Leave every byte outside the object and the one separator, including all neighboring comments.
  if (comma !== undefined && comma >= end) {
    return text.slice(0, node.offset) + text.slice(end, comma) + text.slice(comma + 1);
  }
  if (comma !== undefined) {
    return text.slice(0, comma) + text.slice(comma + 1, node.offset) + text.slice(end);
  }
  return text.slice(0, node.offset) + text.slice(end);
}

function appendGroup(text: string, root: Node, group: Record<string, unknown>): string {
  const style = formatting(text, root);
  const close = root.offset + root.length - 1;
  const closingIndent = indentAt(text, close);
  const insertion = closingIndent === undefined ? close : close - closingIndent.length;
  const last = root.children?.at(-1);
  const end = last ? last.offset + last.length : undefined;
  const trailingComma = end !== undefined && commaBetween(text, end, close) !== undefined;
  const prefix = /[\r\n]/.test(text.charAt(insertion - 1)) ? '' : style.eol;
  const addition = prefix + style.base + formatGroup(group, style) + (trailingComma ? ',' : '') +
    style.eol + (closingIndent === undefined ? style.rootIndent : '');
  let result = text.slice(0, insertion) + addition + text.slice(insertion);
  if (end !== undefined && !trailingComma) {
    result = result.slice(0, end) + ',' + result.slice(end);
  }
  return result;
}

/**
 * Update by ownership marker only, or delete with null. Incoming groups must include name/vendor/byokStudioId.
 * Objects merge recursively; the supplied models array replaces membership/order and merges surviving models by ID.
 * Other arrays replace their previous values. Only the owned object span is reformatted; surrounding JSONC is untouched.
 */
export function updateOwnedGroup(
  text: string, providerId: string, group: Record<string, unknown> | null, options: OwnedGroupUpdateOptions = {}
): string {
  checkProviderId(providerId);
  const { groups, root } = parseNativeGroups(text);
  const index = groups.findIndex(candidate => candidate.byokStudioId === providerId);
  if (group === null) { return index < 0 ? text : removeElement(text, root, index); }
  const incoming = cloneJson(group);
  if (!isRecord(incoming)) { throw new Error(t('托管分组必须是对象。')); }
  checkOwnedGroup(incoming, providerId);
  if (groups.some(candidate => candidate.vendor === 'customendpoint' && candidate.name === incoming.name &&
    candidate.byokStudioId !== providerId)) {
    throw new Error(t('其他 customendpoint 分组已使用此名称。'));
  }
  const previous = groups[index];
  const node = root.children?.[index];
  if (node) { checkOwnedTree(node); }
  const merged = previous ? mergeRecords(previous, incoming) : incoming;
  if (previous && own(incoming, 'models')) {
    const oldModels = own(previous, 'models') ? modelsById(previous.models) : new Map<string, Record<string, unknown>>();
    merged.models = [...modelsById(incoming.models)].map(([id, model]) => {
      const retained = { ...oldModels.get(id) };
      for (const field of options.managedModelFields ?? []) delete retained[field];
      return mergeRecords(retained, model);
    });
  }
  for (const field of options.replaceFields ?? []) {
    if (requiredKeys.has(field) || field === 'models') throw new Error(t('标识和模型字段具有专用的合并规则。'));
    if (own(incoming, field)) merged[field] = incoming[field];
    else delete merged[field];
  }
  for (const field of options.removeFields ?? []) {
    if (requiredKeys.has(field)) { throw new Error(t('不能删除托管分组的必需标识字段。')); }
    delete merged[field];
  }
  checkOwnedGroup(merged, providerId);
  if (previous && sameJson(previous, merged)) { return text; }
  // Validate retained values too, preventing JSON.stringify from silently changing nonfinite numbers.
  const safeGroup = cloneJson(merged) as Record<string, unknown>;
  if (!node) { return appendGroup(text, root, safeGroup); }
  return text.slice(0, node.offset) + formatGroup(safeGroup, formatting(text, root, node)) + text.slice(node.offset + node.length);
}

/** Apply changes in order; throws without returning a partial result when any change is invalid. */
export function patchOwnedGroups(text: string, changes: readonly OwnedGroupChange[]): string {
  parseNativeGroups(text);
  return changes.reduce((current, change) => updateOwnedGroup(current, change.providerId, change.group, change), text);
}

/** Remove only legacy references with all expected identity fields and an explicitly known provider ID. */
export function removeLegacyGroups(text: string, providerIds: readonly string[]): string {
  providerIds.forEach(checkProviderId);
  const known = new Set(providerIds);
  let result = text;
  for (;;) {
    const { groups, root } = parseNativeGroups(result);
    const index = groups.findIndex(group => group.vendor === 'byok-studio' && typeof group.providerId === 'string' &&
      known.has(group.providerId) && typeof group.byokStudioGroupName === 'string');
    if (index < 0) { return result; }
    result = removeElement(result, root, index);
  }
}
