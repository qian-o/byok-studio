(() => {
  'use strict';

  const vscode = acquireVsCodeApi();
  const { t } = globalThis.ByokI18n;
  const $ = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const PARAMETER_FIELDS = ['contextWindow', 'maxInputTokens', 'maxOutputTokens', 'defaultOutputTokens', 'toolCalling', 'vision', 'thinking', 'supportsReasoningEffort'];
  const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const vendors = globalThis.ByokModelVendors;
  const API_TYPES = vendors.apiTypes;
  const ENDPOINT_FIELDS = { responses: 'responses-url', chatCompletions: 'chat-completions-url', messages: 'messages-url' };
  const PROTOCOL_NAMES = { responses: 'Responses', chatCompletions: 'Chat Completions', messages: 'Messages' };
  const ordering = globalThis.ByokModelOrder;
  const contextPolicy = globalThis.ByokContextPolicy;
  const { inputCeiling } = contextPolicy;
  const pendingRequests = new Map();
  const drafts = new Map();
  const dialogFocus = new WeakMap();
  let state = null;
  let activeId = null;
  let busy = null;
  let sequence = 0;
  let modelSession = null;
  let databaseSession = null;
  let databaseEditor = null;
  let pendingConfirm = null;
  let toastTimer;

  function node(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    svg.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function iconButton(name, label, className = '') {
    const button = node('button', `icon-button ${className}`);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.append(icon(name));
    return button;
  }

  function message(target, text = '') {
    $(target).textContent = text;
    $(target).hidden = !text;
  }

  function safeError(error) {
    let text = error instanceof Error ? error.message : typeof error === 'string' ? error : t('操作失败，请重试。');
    for (const draft of drafts.values()) {
      if (draft.apiKey) text = text.split(draft.apiKey).join(t('[密钥已隐藏]'));
      if (draft.apiKey.trim()) text = text.split(draft.apiKey.trim()).join(t('[密钥已隐藏]'));
    }
    return text;
  }

  function errorToast(text) {
    clearTimeout(toastTimer);
    const element = $('toast');
    const dialogs = [...document.querySelectorAll('dialog[open]')];
    (dialogs.at(-1) || document.body).append(element);
    element.setAttribute('role', 'alert');
    element.setAttribute('aria-live', 'assertive');
    element.classList.toggle('error-toast', true);
    element.textContent = text;
    element.hidden = false;
    toastTimer = setTimeout(() => { element.hidden = true; }, 8000);
  }

  function request(command, payload) {
    const id = `webview-${Date.now()}-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(t('扩展暂未响应。操作可能仍在进行，请重新载入配置确认结果后再试。')));
      }, 180000);
      pendingRequests.set(id, { resolve, reject, timer });
      try {
        vscode.postMessage(payload === undefined ? { id, command } : { id, command, payload });
      } catch {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(new Error(t('无法与扩展通信，请重新打开 BYOK Studio。')));
      }
    });
  }

  window.addEventListener('message', event => {
    const incoming = event.data;
    if (!incoming || typeof incoming !== 'object') return;
    if (incoming.event === 'state') {
      try { applyState(incoming.data); }
      catch (error) { errorToast(safeError(error)); }
      return;
    }
    if (typeof incoming.id !== 'string' || typeof incoming.ok !== 'boolean') return;
    const pending = pendingRequests.get(incoming.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRequests.delete(incoming.id);
    if (incoming.ok) pending.resolve(incoming.data);
    else pending.reject(new Error(typeof incoming.error === 'string' ? incoming.error : t('扩展未能完成此操作。')));
  });

  function unavailable(element, value) {
    element.dataset.unavailable = String(Boolean(value));
    element.disabled = Boolean(busy) || Boolean(value) || (!state && !element.hasAttribute('data-initial-action'));
  }

  function syncControls() {
    for (const element of document.querySelectorAll('button, input, select, textarea')) {
      element.disabled = Boolean(busy) || element.dataset.unavailable === 'true' || (!state && !element.hasAttribute('data-initial-action'));
    }
    for (const summary of document.querySelectorAll('summary')) summary.setAttribute('aria-disabled', String(Boolean(busy)));
    $('studio').setAttribute('aria-busy', String(Boolean(busy) || !state));
    $('request-status').textContent = busy || '';
  }

  async function runAction(label, action, errorTarget) {
    if (busy) return false;
    busy = label;
    $('toast').hidden = true;
    syncControls();
    if (errorTarget) message(errorTarget);
    try {
      await action();
      return true;
    } catch (error) {
      const text = safeError(error);
      if (errorTarget) message(errorTarget, text);
      else errorToast(text);
      return false;
    } finally {
      busy = null;
      renderStatus();
      renderDatabaseStatus();
      syncControls();
    }
  }

  // Only these configuration fields cross the bridge. Secret input lives on its draft.
  function providerConfig(provider) {
    return {
      id: provider.id,
      name: provider.name,
      ...vendors.normalizeRouting(provider),
      enabled: provider.enabled,
      zeroDataRetentionEnabled: typeof provider.zeroDataRetentionEnabled === 'boolean' ? provider.zeroDataRetentionEnabled
        : typeof provider.zdr === 'boolean' ? provider.zdr : provider.models.length > 0 && provider.models.every(model => model.zdr === true),
      models: provider.models.filter(model => !vendors.excludedKind(model.id)).map(model => ({
        id: model.id,
        name: model.name || '',
        discoveredName: model.discoveredName || '',
        overrides: Object.fromEntries(PARAMETER_FIELDS.filter(field => own(model.overrides || {}, field)).map(field => [field, clone(model.overrides[field])])),
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
      }))
    };
  }

  function makeDraft(provider, saved = true) {
    const config = providerConfig(provider);
    return { provider: config, baseline: saved ? clone(config) : null, hasKey: provider.hasKey === true, apiKey: '', conflict: false, selectedModels: new Set(), splitVisited: config.routingMode === 'split' };
  }

  function currentDraft() { return drafts.get(activeId); }
  function dirty(draft) { return !draft.baseline || !equal(draft.provider, draft.baseline) || Boolean(draft.apiKey.trim()); }
  function databaseDirty() { return Boolean(databaseSession && !equal(databaseSession.database, databaseSession.baseline)); }
  function baseParameters(id, database = state.database) { return own(database.models, id) ? database.models[id] : database.defaults; }
  function modelName(model, database = state.database) {
    return model.name || (own(database.models, model.id) && database.models[model.id].name) || model.id;
  }
  function recordName(record, id) { return record.name || id; }
  function sourceNote(record) { return `${record.source || t('未填写来源')} · ${record.verifiedAt ? t('核验于 {0}', record.verifiedAt) : record.aliasOf ? t('代理映射未核实') : t('未完整核验')}`; }

  function validateState(next) {
    if (!next || !Array.isArray(next.providers) || !Number.isSafeInteger(next.revision) || next.revision < 0 || !next.database || next.database.schemaVersion !== 1 || !next.database.defaults || !next.database.models || Array.isArray(next.database.models)) {
      throw new Error(t('扩展返回的配置格式无效，请重新打开 BYOK Studio。'));
    }
    for (const provider of next.providers) {
      if (!provider || typeof provider.id !== 'string' || typeof provider.name !== 'string' || typeof provider.enabled !== 'boolean' || (provider.zeroDataRetentionEnabled !== undefined && typeof provider.zeroDataRetentionEnabled !== 'boolean') || !Array.isArray(provider.models)) {
        throw new Error(t('扩展返回的供应商配置无效。'));
      }
      const validEndpoints = provider.endpoints && typeof provider.endpoints === 'object' && !Array.isArray(provider.endpoints) && API_TYPES.every(type => provider.endpoints[type] === undefined || typeof provider.endpoints[type] === 'string');
      const legacyEndpoints = provider.endpoints === undefined && typeof provider.url === 'string' && API_TYPES.includes(provider.apiType);
      const validMode = provider.routingMode === undefined || ['unified', 'split'].includes(provider.routingMode);
      const validUnified = provider.unified === undefined || (provider.unified && API_TYPES.includes(provider.unified.apiType) && typeof provider.unified.url === 'string');
      const validProtocols = provider.modelProtocols === undefined || (provider.modelProtocols && typeof provider.modelProtocols === 'object' && !Array.isArray(provider.modelProtocols) && Object.values(provider.modelProtocols).every(apiType => API_TYPES.includes(apiType)));
      const validLegacyProtocols = provider.vendorProtocols === undefined || (provider.vendorProtocols && typeof provider.vendorProtocols === 'object' && !Array.isArray(provider.vendorProtocols) && Object.values(provider.vendorProtocols).every(apiType => API_TYPES.includes(apiType)));
      if ((!validEndpoints && !legacyEndpoints) || !validMode || !validUnified || !validProtocols || !validLegacyProtocols) throw new Error(t('扩展返回的供应商协议配置无效。'));
    }
  }

  // Acknowledgements release only the saved draft; unrelated dirty drafts remain intact.
  function applyState(next, acknowledgement = {}) {
    validateState(next);
    const previousActive = currentDraft();
    const previousDatabase = state?.database;
    if (!state || next.revision >= state.revision) {
      if (next.modelRules) vendors.configure(next.modelRules);
      state = clone(next);
    }
    if (acknowledgement.reset) {
      for (const draft of drafts.values()) draft.apiKey = '';
      drafts.clear();
    }
    if (acknowledgement.providerId) {
      const saved = next.providers.find(provider => provider.id === acknowledgement.providerId);
      const old = drafts.get(acknowledgement.providerId);
      if (old) old.apiKey = '';
      if (saved) drafts.set(saved.id, makeDraft(saved));
    }
    if (acknowledgement.deletedId) {
      const removed = drafts.get(acknowledgement.deletedId);
      if (removed) removed.apiKey = '';
      drafts.delete(acknowledgement.deletedId);
    }
    if (acknowledgement.database && databaseSession) {
      databaseSession.database = clone(next.database);
      databaseSession.baseline = clone(next.database);
      databaseSession.conflict = false;
    }
    const remote = new Map(state.providers.map(provider => [provider.id, provider]));
    for (const [id, draft] of drafts) {
      const incoming = remote.get(id);
      const protectedDraft = dirty(draft) || modelSession?.providerId === id;
      if (!incoming) {
        if (draft.baseline && protectedDraft) draft.conflict = true;
        else if (draft.baseline) drafts.delete(id);
        continue;
      }
      const changedRemotely = !equal(providerConfig(incoming), draft.baseline) || incoming.hasKey !== draft.hasKey;
      if (protectedDraft && changedRemotely) draft.conflict = true;
      else if (!protectedDraft && changedRemotely) drafts.set(id, makeDraft(incoming));
    }
    for (const provider of state.providers) if (!drafts.has(provider.id)) drafts.set(provider.id, makeDraft(provider));
    if (!drafts.has(activeId)) activeId = drafts.keys().next().value || null;
    if (databaseSession && !equal(state.database, databaseSession.baseline)) {
      if (databaseDirty() || databaseEditor) databaseSession.conflict = true;
      else {
        databaseSession.database = clone(state.database);
        databaseSession.baseline = clone(state.database);
        databaseSession.conflict = false;
      }
    }
    if (modelSession && (drafts.get(modelSession.providerId)?.conflict || (previousDatabase && !equal(previousDatabase, state.database)))) {
      modelSession.stale = true;
      $('model-update').hidden = false;
    }
    $('loading-state').hidden = true;
    $('load-error').hidden = true;
    $('settings-card').hidden = false;
    renderMain(previousActive !== currentDraft() || Boolean(acknowledgement.reset));
    if (databaseSession) renderDatabase();
    renderUpdateBanner();
    syncControls();
  }

  function renderUpdateBanner() {
    $('update-banner').hidden = ![...drafts.values()].some(draft => draft.conflict) && !databaseSession?.conflict;
  }

  function renderSidebar() {
    const content = document.createDocumentFragment();
    for (const [id, draft] of drafts) {
      const provider = draft.provider;
      const name = provider.name.trim() || t('新供应商');
      const button = node('button', `provider-nav${id === activeId ? ' active' : ''}`);
      button.type = 'button';
      button.dataset.providerId = id;
      button.setAttribute('aria-label', name);
      if (id === activeId) button.setAttribute('aria-current', 'page');
      const avatar = node('span', 'provider-avatar', [...name][0].toUpperCase());
      avatar.setAttribute('aria-hidden', 'true');
      button.append(avatar, node('span', 'provider-label', name));
      content.append(button);
    }
    $('provider-list').replaceChildren(content);
  }

  function renderStatus() {
    const draft = currentDraft();
    unavailable($('save-provider'), !draft);
    unavailable($('refresh-models'), !draft);
    if (!draft) return;
    const hasKey = state?.providers.find(item => item.id === draft.provider.id)?.hasKey === true;
    $('api-key').placeholder = hasKey ? t('留空保持已存密钥') : t('输入 API Key（可选）');
    $('refresh-models').title = t('从当前模式的地址获取模型并替换草稿列表，保留同 ID 模型的设置与协议分配');
  }

  function modelRow(model, selectable = false) {
    const draft = currentDraft();
    const name = modelName(model);
    const row = node('div', 'model-row');
    row.dataset.modelId = model.id;
    if (selectable) {
      const checkbox = node('input', 'model-checkbox');
      checkbox.type = 'checkbox';
      checkbox.dataset.selectModel = model.id;
      checkbox.checked = draft.selectedModels.has(model.id);
      checkbox.setAttribute('aria-label', t('选择模型 {0}', name));
      row.append(checkbox);
      row.classList.toggle('selected', checkbox.checked);
    }
    const open = node('button', 'model-open');
    open.type = 'button';
    open.setAttribute('aria-label', t('设置模型 {0}', name));
    open.append(node('span', 'model-label', name));
    const date = own(state.database.models, model.id) ? state.database.models[model.id].releaseDate : undefined;
    open.title = `${name}\n${model.id}\n${ordering.validDate(date) ? t('发布日期：{0}', date) : t('发布日期未知')}`;
    const actions = node('span', 'model-actions');
    actions.append(iconButton('edit', t('编辑模型 {0}', name), 'edit-model'), iconButton('trash', t('移除模型 {0}', name), 'remove-model'));
    row.append(open, actions);
    return row;
  }

  function syncSelections(announcement) {
    const draft = currentDraft();
    if (!draft) return;
    const split = draft.provider.routingMode === 'split';
    const lists = split ? vendors.protocolLists(draft.provider) : [];
    const selected = lists.map(list => ({ ...list, count: list.models.filter(model => draft.selectedModels.has(model.id)).length }));
    const total = selected.reduce((sum, list) => sum + list.count, 0);
    $('model-selection').hidden = !total;
    $('model-selection-count').textContent = t('已选 {0}', total);
    $('model-selection-status').textContent = announcement || (split ? t('已选 {0} 个模型', total) : '');
    for (const { apiType, models, count } of selected) {
      const selectAll = $(`select-all-${apiType}`);
      selectAll.checked = models.length > 0 && count === models.length;
      selectAll.indeterminate = count > 0 && count < models.length;
      unavailable(selectAll, !models.length);
      const incoming = total - count;
      const target = $(`move-to-${apiType}`);
      target.hidden = !total;
      target.querySelector('span').textContent = incoming ? t('移到这里 · {0}', incoming) : t('已在这里');
      const sources = selected.filter(list => list.apiType !== apiType && list.count).map(list => t('{0} {1} 个', PROTOCOL_NAMES[list.apiType], list.count)).join(t('、'));
      const label = incoming ? t('将 {0} 个已选模型从 {1} 移到 {2}', incoming, sources, PROTOCOL_NAMES[apiType]) : t('已选的 {0} 个模型均在 {1}', count, PROTOCOL_NAMES[apiType]);
      target.setAttribute('aria-label', label);
      target.title = label;
      unavailable(target, !incoming);
      target.closest('[data-protocol]').classList.toggle('transfer-target', incoming > 0);
    }
    for (const checkbox of $('model-list').querySelectorAll('[data-select-model]')) {
      checkbox.checked = draft.selectedModels.has(checkbox.dataset.selectModel);
      checkbox.closest('[data-model-id]').classList.toggle('selected', checkbox.checked);
    }
  }

  function renderModels() {
    const draft = currentDraft();
    if (!draft) return;
    const content = document.createDocumentFragment();
    const split = draft.provider.routingMode === 'split';
    $('model-list').classList.toggle('split-models', split);
    const total = draft.provider.models.length;
    $('model-total').textContent = `${total}`;
    $('model-total').setAttribute('aria-label', t('共 {0} 个模型', total));
    if (split) {
      for (const { apiType, models } of vendors.protocolLists(draft.provider)) {
        const section = node('section', 'protocol-column');
        section.dataset.protocol = apiType;
        section.setAttribute('aria-labelledby', `protocol-heading-${apiType}`);
        const header = node('header', 'model-group-header');
        const heading = node('h4', '', PROTOCOL_NAMES[apiType]);
        heading.id = `protocol-heading-${apiType}`;
        const count = node('span', 'model-group-count', `${models.length}`);
        count.setAttribute('aria-label', t('{0} 个模型', models.length));
        heading.append(count);
        const selectLabel = node('label', 'checkbox compact');
        const selectAll = node('input');
        selectAll.type = 'checkbox';
        selectAll.id = `select-all-${apiType}`;
        selectAll.dataset.selectAll = apiType;
        selectAll.setAttribute('aria-label', t('全选 {0} 模型', PROTOCOL_NAMES[apiType]));
        selectLabel.append(selectAll, document.createTextNode(t('全选')));
        header.append(heading, selectLabel);
        const move = node('button', 'button small transfer-button');
        move.id = `move-to-${apiType}`;
        move.type = 'button';
        move.dataset.moveTo = apiType;
        move.hidden = true;
        move.append(icon('arrow'), node('span'));
        const endpoint = node('div', 'field endpoint-field');
        const label = node('label', 'visually-hidden', 'Base URL');
        label.setAttribute('for', ENDPOINT_FIELDS[apiType]);
        const input = node('input');
        input.id = ENDPOINT_FIELDS[apiType];
        input.type = 'url';
        input.maxLength = 4096;
        input.placeholder = 'https://api.example.com/v1';
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.dataset.endpoint = apiType;
        input.value = draft.provider.endpoints[apiType];
        input.setAttribute('aria-label', `${PROTOCOL_NAMES[apiType]} Base URL`);
        endpoint.append(label, input);
        const list = node('div', 'protocol-models');
        for (const model of models) list.append(modelRow(model, true));
        if (!models.length) list.append(node('p', 'empty-models', t('暂无模型')));
        const controls = node('div', 'protocol-controls');
        controls.append(header, endpoint, move);
        section.append(controls, list);
        content.append(section);
      }
    } else {
      const models = draft.provider.models.filter(model => !vendors.excludedKind(model.id));
      for (const model of models) content.append(modelRow(model));
      if (!models.length) content.append(node('p', 'empty-models', t('暂无模型')));
    }
    $('model-list').replaceChildren(content);
    syncSelections();
  }

  function renderRouting() {
    const provider = currentDraft().provider;
    const split = provider.routingMode === 'split';
    $('routing-unified').checked = !split;
    $('routing-split').checked = split;
    $('unified-endpoint').hidden = split;
  }

  function renderMain(syncFields = true) {
    renderSidebar();
    const draft = currentDraft();
    $('provider-panel').hidden = !draft;
    $('empty-provider').hidden = Boolean(draft);
    if (draft) {
      const provider = draft.provider;
      if (syncFields) {
        $('provider-name').value = provider.name;
        $('unified-api-type').value = provider.unified.apiType;
        $('unified-url').value = provider.unified.url;
        $('provider-zdr-enabled').checked = provider.zeroDataRetentionEnabled;
        $('api-key').value = draft.apiKey;
        hideKey();
        clearValidation('provider-form');
        message('provider-error');
      }
      renderRouting();
      renderModels();
    } else {
      $('api-key').value = '';
      hideKey();
    }
    renderStatus();
    renderUpdateBanner();
    syncControls();
  }

  function hideKey() {
    $('api-key').type = 'password';
    $('toggle-key').setAttribute('aria-label', t('显示 API Key'));
    $('toggle-key').setAttribute('aria-pressed', 'false');
    $('toggle-key').title = t('显示 API Key');
  }

  function changed() {
    message('provider-error');
    clearValidation('provider-form');
    renderStatus();
    renderSidebar();
    syncControls();
  }

  function clearValidation(formId) {
    for (const field of $(formId).querySelectorAll('[aria-invalid]')) field.removeAttribute('aria-invalid');
  }

  function formError(target, text, fieldId) {
    message(target, text);
    if (fieldId) {
      const field = $(fieldId);
      for (let parent = field.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
      field.setAttribute('aria-invalid', 'true');
      field.focus();
    }
  }

  function validId(id) { return typeof id === 'string' && Boolean(id) && id.length <= 512 && !/[\s\u0000-\u001f\u007f]/.test(id) && !['__proto__', 'prototype', 'constructor'].includes(id); }
  function validEffort(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(value); }
  function effortError(values) {
    if (!Array.isArray(values) || values.length > 32 || values.some(value => !validEffort(value))) return t('最多支持 32 个推理档位，每项为 1–40 个英文字母、数字、连字符或下划线。');
    return null;
  }
  function tokenError(parameters) {
    if (!Number.isSafeInteger(parameters.contextWindow) || !Number.isSafeInteger(parameters.maxOutputTokens) || parameters.contextWindow <= 0 || parameters.maxOutputTokens <= 0 || parameters.contextWindow > 100000000 || parameters.maxOutputTokens > 100000000) return t('上下文窗口和最大输出必须是 1–100000000 的整数。');
    if (parameters.maxInputTokens !== undefined && (!Number.isSafeInteger(parameters.maxInputTokens) || parameters.maxInputTokens <= 0 || parameters.maxInputTokens > 100000000)) return t('最大输入必须是 1–100000000 的整数，或留空自动计算。');
    if (parameters.defaultOutputTokens !== undefined && (!Number.isSafeInteger(parameters.defaultOutputTokens) || parameters.defaultOutputTokens <= 0 || parameters.defaultOutputTokens > 100000000)) return t('单次输出预算必须是 1–100000000 的整数，或留空使用默认值。');
    if ((parameters.contextWindowMode !== 'input' && parameters.maxOutputTokens > parameters.contextWindow) || (parameters.maxInputTokens !== undefined && parameters.maxInputTokens > parameters.contextWindow)) return t('最大输入和最大输出不能超过上下文窗口。');
    if (parameters.contextWindowMode !== 'input' && parameters.maxInputTokens === undefined && parameters.maxOutputTokens >= parameters.contextWindow) return t('最大输出必须小于上下文窗口，或填写有效的独立最大输入。');
    return null;
  }

  function optionalInput(fieldId, key = 'maxInputTokens') {
    const value = $(fieldId).value.trim();
    return value ? { [key]: Number(value) } : {};
  }

  function pricingRatesText(pricing) {
    if (!pricing?.rates) return '';
    const { currency, bands } = pricing.rates;
    return t('{0} / 每百万 tokens\n', currency) + bands.map(band => {
      const priorInput = Math.max(0, ...pricing.thresholds.filter(value => band.inputUpTo == null || value < band.inputUpTo));
      const input = band.inputUpTo == null ? priorInput ? t('输入 > {0}', priorInput.toLocaleString('en-US')) : t('全部输入') : priorInput ? t('输入 {0}–{1}', (priorInput + 1).toLocaleString('en-US'), band.inputUpTo.toLocaleString('en-US')) : t('输入 ≤ {0}', band.inputUpTo.toLocaleString('en-US'));
      const priorOutput = Math.max(0, ...bands.filter(item => item.inputUpTo === band.inputUpTo && item.outputUpTo != null && (band.outputUpTo === null || item.outputUpTo < band.outputUpTo)).map(item => item.outputUpTo));
      const output = band.outputUpTo === undefined ? '' : band.outputUpTo === null ? t('；输出 > {0}', priorOutput.toLocaleString('en-US')) : priorOutput ? t('；输出 {0}–{1}', (priorOutput + 1).toLocaleString('en-US'), band.outputUpTo.toLocaleString('en-US')) : t('；输出 ≤ {0}', band.outputUpTo.toLocaleString('en-US'));
      return t('{0}{1}：输入 {2}，输出 {3}{4}{5}', input, output, band.input, band.output, band.cacheRead === undefined ? '' : t('，缓存读取 {0}', band.cacheRead), band.cacheWrite === undefined ? '' : t('，缓存写入 {0}', band.cacheWrite));
    }).join('\n');
  }

  function syncContextPricing() {
    if (!modelSession) return;
    const parameters = baseParameters($('model-id').value.trim(), modelSession.database);
    const pricing = parameters.contextPricing;
    $('context-pricing-note').textContent = contextPolicy.pricingNote(parameters);
    $('context-pricing-details').hidden = !pricing;
    $('context-pricing-summary').textContent = t('计费资料 · {0}', pricing?.checkedAt ? t('核验于 {0}', pricing.checkedAt) : t('尚未核验'));
    $('context-pricing-source').textContent = [pricing?.source || t('未填写来源'), pricingRatesText(pricing)].filter(Boolean).join('\n');
  }

  function urlError(value) {
    if (value.length > 4096) return t('API Base URL 不能超过 4096 个字符。');
    try {
      const url = new URL(value.trim());
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return t('请填写 http(s) 基础地址，不包含账号、查询参数或片段。');
    } catch { return t('请填写有效的 API Base URL。'); }
    return null;
  }

  function providerProblem(provider, discovery = false) {
    if (!provider.name.trim() || provider.name.length > 200) return { text: t('请填写供应商名称，最多 200 个字符。'), field: 'provider-name' };
    const split = provider.routingMode === 'split';
    const routes = split ? API_TYPES.map(apiType => ({ apiType, url: provider.endpoints[apiType], field: ENDPOINT_FIELDS[apiType] }))
      : [{ ...provider.unified, field: 'unified-url' }];
    for (const route of routes) {
      const invalidUrl = route.url.trim() ? urlError(route.url) : null;
      if (invalidUrl) return { text: `${PROTOCOL_NAMES[route.apiType]}：${invalidUrl}`, field: route.field };
    }
    if (discovery) return routes.some(route => route.url.trim()) ? null
      : { text: split ? t('请至少填写一个协议的基础 URL，再刷新模型。') : t('请填写统一协议的基础 URL，再刷新模型。'), field: routes[0].field };
    if (provider.enabled) {
      for (const model of provider.models) {
        const route = vendors.routeForModel(provider, model.id);
        if (!route.url.trim()) return { text: t('{0} 使用 {1}，请填写对应的基础 URL。', modelName(model), PROTOCOL_NAMES[route.apiType]), field: split ? ENDPOINT_FIELDS[route.apiType] : 'unified-url' };
      }
    }
    if (provider.models.length > 5000) return { text: t('每个供应商最多支持 5000 个模型。') };
    const ids = new Set();
    for (const model of provider.models) {
      if (!validId(model.id) || ids.has(model.id)) return { text: t('模型请求 ID 无效或重复，请打开模型设置检查。'), field: 'add-model' };
      ids.add(model.id);
      const parameters = { ...baseParameters(model.id), ...model.overrides };
      const invalidTokens = tokenError(parameters);
      if (invalidTokens) return { text: `${modelName(model)}：${invalidTokens}` };
      const invalidEfforts = effortError(parameters.supportsReasoningEffort);
      if (invalidEfforts) return { text: `${modelName(model)}：${invalidEfforts}` };
      if (model.name.length > 200 || model.discoveredName.length > 200) return { text: t('模型显示名称不能超过 200 个字符。') };
    }
    return null;
  }

  function preparedProvider(draft) {
    const provider = providerConfig(draft.provider);
    provider.name = provider.name.trim();
    provider.unified.url = provider.unified.url.trim();
    for (const apiType of API_TYPES) provider.endpoints[apiType] = provider.endpoints[apiType].trim();
    for (const model of provider.models) {
      const parameters = { ...baseParameters(model.id), ...model.overrides };
      if (model.reasoningEffort && (!parameters.thinking || !parameters.supportsReasoningEffort.includes(model.reasoningEffort))) delete model.reasoningEffort;
    }
    return provider;
  }

  function showDialog(id, focusId) {
    const dialog = $(id);
    dialogFocus.set(dialog, document.activeElement);
    dialog.showModal();
    if (focusId) $(focusId).focus();
  }

  function confirmAction(title, text, action) {
    if (busy) return;
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = text;
    pendingConfirm = action;
    showDialog('confirm-dialog', 'confirm-cancel');
  }

  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      if (dialog.id === 'model-dialog') modelSession = null;
      if (dialog.id === 'database-editor') databaseEditor = null;
      if (dialog.id === 'database-dialog') databaseSession = null;
      if (dialog.id === 'confirm-dialog') pendingConfirm = null;
      if (state && dialog.id !== 'confirm-dialog') applyState(state);
      const openDialogs = [...document.querySelectorAll('dialog[open]')];
      if ($('toast').parentElement === dialog) (openDialogs.at(-1) || document.body).append($('toast'));
      const previous = dialogFocus.get(dialog);
      const top = openDialogs.at(-1);
      if (previous?.isConnected && !previous.disabled && (!top || top.contains(previous))) previous.focus();
      else if (top) top.querySelector('input:not(:disabled), button:not(:disabled), select:not(:disabled)')?.focus();
      else if (dialog.id !== 'confirm-dialog') (currentDraft() ? $('provider-name') : $('add-provider')).focus();
    });
  }
  for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => { if (!busy) $(button.dataset.close).close(); });
  for (const summary of document.querySelectorAll('summary')) summary.addEventListener('click', event => { if (busy) event.preventDefault(); });
  $('confirm-action').addEventListener('click', () => {
    const action = pendingConfirm;
    pendingConfirm = null;
    $('confirm-dialog').close();
    if (action) action();
  });

  function addProvider() {
    if (!state || busy) return;
    const provider = { id: `provider-${crypto.randomUUID()}`, name: t('新供应商'), ...vendors.normalizeRouting({}), enabled: true, zeroDataRetentionEnabled: false, models: [] };
    currentDraft()?.selectedModels.clear();
    drafts.set(provider.id, makeDraft(provider, false));
    activeId = provider.id;
    renderMain();
    $('provider-name').focus();
    $('provider-name').select();
  }

  async function saveProvider(id) {
    const draft = drafts.get(id);
    if (!draft) return;
    const provider = preparedProvider(draft);
    const problem = providerProblem(provider);
    if (problem) { formError('provider-error', problem.text, problem.field); return; }
    if (draft.apiKey.length > 16000) { formError('provider-error', t('API Key 不能超过 16000 个字符。'), 'api-key'); return; }
    await runAction(t('正在保存供应商…'), async () => {
      const payload = { provider };
      if (draft.apiKey.trim()) payload.apiKey = draft.apiKey.trim();
      const next = await request('saveProvider', payload);
      applyState(next, { providerId: id });
      $('api-key').value = currentDraft()?.apiKey || '';
      hideKey();
    }, 'provider-error');
  }

  async function deleteProvider(id) {
    const draft = drafts.get(id);
    if (!draft) return;
    if (!state.providers.some(provider => provider.id === id)) {
      draft.apiKey = '';
      drafts.delete(id);
      activeId = drafts.keys().next().value || null;
      renderMain();
      return;
    }
    await runAction(t('正在删除供应商…'), async () => {
      const next = await request('deleteProvider', { id });
      applyState(next, { deletedId: id });
    }, 'provider-error');
  }

  async function discoverModels() {
    const draft = currentDraft();
    if (!draft || busy) return;
    const provider = preparedProvider(draft);
    const problem = providerProblem(provider, true);
    if (problem) { formError('provider-error', problem.text, problem.field); return; }
    if (draft.apiKey.length > 16000) { formError('provider-error', t('API Key 不能超过 16000 个字符。'), 'api-key'); return; }
    draft.selectedModels.clear();
    syncSelections();
    $('model-list').setAttribute('aria-busy', 'true');
    await runAction(t('正在刷新模型…'), async () => {
      const payload = { provider };
      if (draft.apiKey.trim()) payload.apiKey = draft.apiKey.trim();
      const result = await request('discoverModels', payload);
      if (!result || !Array.isArray(result.models) || result.models.some(model => !model || !validId(model.id) || typeof model.name !== 'string')) throw new Error(t('扩展返回的模型列表格式无效。'));
      if (result.warnings !== undefined && (!Array.isArray(result.warnings) || result.warnings.some(warning => typeof warning !== 'string'))) throw new Error(t('扩展返回的刷新提示格式无效。'));
      const target = drafts.get(provider.id);
      if (!target || !equal(vendors.normalizeRouting(preparedProvider(target)), vendors.normalizeRouting(provider))) throw new Error(t('协议配置已更新，请重新刷新模型。'));
      const models = vendors.replaceModels(target.provider.models, result.models);
      if (models.length > 5000) throw new Error(t('返回的聊天模型超过每个供应商 5000 个模型的上限，请手动添加所需模型。'));
      target.provider.models = models;
      target.provider.modelProtocols = vendors.normalizeRouting(target.provider).modelProtocols;
      target.selectedModels.clear();
      renderMain(false);
      if (result.warnings?.length) message('provider-error', safeError(result.warnings.join('；')));
    }, 'provider-error');
    $('model-list').setAttribute('aria-busy', 'false');
    renderStatus();
  }

  $('add-provider').addEventListener('click', addProvider);
  $('empty-add').addEventListener('click', addProvider);
  $('provider-list').addEventListener('click', event => {
    const button = event.target.closest('[data-provider-id]');
    if (!button || busy) return;
    currentDraft()?.selectedModels.clear();
    activeId = button.dataset.providerId;
    currentDraft()?.selectedModels.clear();
    renderMain();
    $('provider-list').querySelector('[aria-current="page"]')?.focus();
  });
  $('provider-name').addEventListener('input', event => {
    const draft = currentDraft();
    if (!draft) return;
    draft.provider.name = event.target.value;
    changed();
  });
  for (const mode of ['unified', 'split']) $(`routing-${mode}`).addEventListener('change', event => {
    const draft = currentDraft();
    if (!draft || busy || !event.target.checked || draft.provider.routingMode === mode) return;
    if (mode === 'split') {
      if (!draft.splitVisited && API_TYPES.every(apiType => !draft.provider.endpoints[apiType].trim())) {
        for (const apiType of API_TYPES) draft.provider.endpoints[apiType] = draft.provider.unified.url;
      }
      draft.splitVisited = true;
    }
    draft.provider.routingMode = mode;
    draft.selectedModels.clear();
    renderRouting();
    renderModels();
    changed();
  });
  $('unified-api-type').addEventListener('change', event => {
    const draft = currentDraft();
    if (!draft || busy || !API_TYPES.includes(event.target.value)) return;
    draft.provider.unified.apiType = event.target.value;
    renderModels();
    changed();
  });
  function unifiedUrlChanged(event) {
    if (!currentDraft() || busy) return;
    currentDraft().provider.unified.url = event.target.value;
    changed();
  }
  $('unified-url').addEventListener('input', unifiedUrlChanged);
  $('unified-url').addEventListener('change', unifiedUrlChanged);
  function endpointChanged(event) {
    const input = event.target.closest('[data-endpoint]');
    const draft = currentDraft();
    if (!input || !draft || busy || !API_TYPES.includes(input.dataset.endpoint)) return;
    draft.provider.endpoints[input.dataset.endpoint] = input.value;
    changed();
  }
  $('model-list').addEventListener('input', endpointChanged);
  $('provider-zdr-enabled').addEventListener('change', event => { if (currentDraft()) { currentDraft().provider.zeroDataRetentionEnabled = event.target.checked; changed(); } });
  $('api-key').addEventListener('input', event => { if (currentDraft()) { currentDraft().apiKey = event.target.value; changed(); } });
  $('toggle-key').addEventListener('click', () => {
    const visible = $('api-key').type === 'password';
    $('api-key').type = visible ? 'text' : 'password';
    $('toggle-key').setAttribute('aria-pressed', String(visible));
    $('toggle-key').setAttribute('aria-label', visible ? t('隐藏 API Key') : t('显示 API Key'));
    $('toggle-key').title = visible ? t('隐藏 API Key') : t('显示 API Key');
  });
  $('model-list').addEventListener('change', event => {
    endpointChanged(event);
    const draft = currentDraft();
    if (!draft || busy || draft.provider.routingMode !== 'split') return;
    const checkbox = event.target.closest('[data-select-model]');
    const selectAll = event.target.closest('[data-select-all]');
    if (checkbox) {
      if (checkbox.checked) draft.selectedModels.add(checkbox.dataset.selectModel);
      else draft.selectedModels.delete(checkbox.dataset.selectModel);
    } else if (selectAll) {
      const list = vendors.protocolLists(draft.provider).find(list => list.apiType === selectAll.dataset.selectAll);
      for (const model of list.models) {
        if (selectAll.checked) draft.selectedModels.add(model.id);
        else draft.selectedModels.delete(model.id);
      }
    }
    syncSelections();
    syncControls();
  });
  $('clear-model-selection').addEventListener('click', () => {
    const draft = currentDraft();
    if (!draft || busy) return;
    draft.selectedModels.clear();
    syncSelections();
    $('model-list').focus();
  });
  $('provider-form').addEventListener('submit', event => {
    event.preventDefault();
    const draft = currentDraft();
    if (!draft || busy) return;
    const id = draft.provider.id;
    if (draft.conflict) confirmAction(t('保存当前供应商草稿'), t('此供应商已在其他位置修改或删除。保存将以当前草稿覆盖该供应商，其他供应商不受影响。'), () => saveProvider(id));
    else void saveProvider(id);
  });
  $('delete-provider').addEventListener('click', () => {
    const draft = currentDraft();
    if (!draft) return;
    const id = draft.provider.id;
    confirmAction(t('删除供应商'), t('删除“{0}”及其模型配置和已存密钥？', draft.provider.name.trim() || t('新供应商')), () => deleteProvider(id));
  });
  $('refresh-models').addEventListener('click', () => { void discoverModels(); });

  function renderEfforts(containerId, values) {
    const content = document.createDocumentFragment();
    for (const value of new Set([...EFFORTS, ...values])) {
      const label = node('label', 'checkbox');
      const input = node('input');
      input.type = 'checkbox';
      input.value = value;
      input.checked = values.includes(value);
      label.append(input, document.createTextNode(value));
      content.append(label);
    }
    $(containerId).replaceChildren(content);
  }

  function readEfforts(containerId, extraId) {
    const checked = [...$(containerId).querySelectorAll('input:checked')].map(input => input.value);
    const extra = $(extraId).value.split(/[,，]/).map(value => value.trim()).filter(Boolean);
    return [...new Set([...checked, ...extra])];
  }

  function syncReasoning(selected = $('reasoning-effort').value) {
    const declared = readEfforts('effort-options', 'model-extra-efforts').filter(validEffort);
    const id = $('model-id').value.trim();
    const parameters = { ...baseParameters(id, modelSession.database), thinking: $('cap-thinking').checked, supportsReasoningEffort: declared };
    const provider = drafts.get(modelSession.providerId).provider;
    const apiType = vendors.routeForModel(provider, modelSession.editingId || id).apiType;
    const projection = globalThis.ByokOfficialEffort.projectEfforts(parameters, apiType);
    const values = projection.levels;
    const content = document.createDocumentFragment();
    const automatic = node('option', '', t('默认（不指定）'));
    automatic.value = '';
    content.append(automatic);
    for (const value of values) {
      const option = node('option', '', value);
      option.value = value;
      content.append(option);
    }
    const thinking = $('cap-thinking').checked;
    $('reasoning-effort').replaceChildren(content);
    $('reasoning-effort').value = thinking && values.includes(selected) ? selected : '';
    unavailable($('reasoning-effort'), !thinking || !values.length);
    const controls = modelSession ? baseParameters($('model-id').value.trim(), modelSession.database).reasoningControls : undefined;
    $('reasoning-note').textContent = (!thinking ? t('启用思考能力后可指定实际请求档位。') : projection.rejected.length ? t('部分档位需要官方暂不支持的参数，已隐藏。') : !values.length ? t('此条目没有官方推理档位枚举，保留服务端默认。') : t('请求时使用此档位；默认由服务商决定。')) + (controls?.note ? ` ${controls.note}` : '');
  }

  function fillModelParameters(parameters, selected = '') {
    $('context-window').value = parameters.contextWindow;
    $('max-input').value = parameters.maxInputTokens ?? '';
    $('max-output').value = parameters.maxOutputTokens;
    $('default-output').value = parameters.defaultOutputTokens ?? '';
    $('cap-tools').checked = parameters.toolCalling;
    $('cap-vision').checked = parameters.vision;
    $('cap-thinking').checked = parameters.thinking;
    renderEfforts('effort-options', parameters.supportsReasoningEffort);
    $('model-extra-efforts').value = '';
    syncReasoning(selected);
    syncContextPricing();
    syncControls();
  }

  function renderModelMatch() {
    if (!modelSession) return;
    const id = $('model-id').value.trim();
    const matched = own(modelSession.database.models, id);
    $('model-match').textContent = !id ? t('在高级选项中设置请求模型 ID。') : matched ? t('已精确匹配模型参数') : t('使用初始配置，可按需调整');
    $('model-match').classList.toggle('match-ok', matched);
    $('model-source').textContent = id ? sourceNote(baseParameters(id, modelSession.database)) : '';
  }

  function openModel(id = null) {
    const draft = currentDraft();
    if (!draft || busy) return;
    const model = id ? draft.provider.models.find(item => item.id === id) : { id: '', name: '', discoveredName: '', overrides: {} };
    if (!model) return;
    modelSession = { providerId: draft.provider.id, original: clone(model), editingId: id, database: clone(state.database), requestId: model.id, automaticName: model.name ? null : (model.id ? modelName(model) : ''), stale: false };
    $('model-title').textContent = id ? t('模型设置') : t('添加模型');
    $('apply-model').textContent = id ? t('应用到草稿') : t('添加');
    $('advanced-options').open = !id;
    $('model-update').hidden = true;
    $('model-id').value = model.id;
    $('model-name').value = model.id ? modelName(model) : '';
    clearValidation('model-form');
    message('model-error');
    const choices = new Map(Object.entries(state.database.models).filter(([modelId]) => !vendors.excludedKind(modelId)).map(([modelId, record]) => [modelId, recordName(record, modelId)]));
    for (const item of draft.provider.models) choices.set(item.id, modelName(item));
    const content = document.createDocumentFragment();
    for (const [modelId, name] of choices) {
      const option = node('option');
      option.value = modelId;
      option.label = name;
      content.append(option);
    }
    $('model-id-options').replaceChildren(content);
    fillModelParameters({ ...baseParameters(model.id, modelSession.database), ...model.overrides }, model.reasoningEffort || '');
    renderModelMatch();
    showDialog('model-dialog', id ? 'model-name' : 'model-id');
  }

  function changeModelId() {
    if (!modelSession) return;
    const id = $('model-id').value.trim();
    if (id === modelSession.requestId) return;
    modelSession.requestId = id;
    const original = modelSession.original;
    const sourceModel = drafts.get(modelSession.providerId)?.provider.models.find(model => model.id === id);
    const discoveredName = sourceModel?.discoveredName || (id === original.id ? original.discoveredName : '');
    const automatic = !$('model-name').value.trim() || $('model-name').value === modelSession.automaticName;
    if (automatic) {
      const name = id ? modelName({ id, name: '', discoveredName }, modelSession.database) : '';
      $('model-name').value = name;
      modelSession.automaticName = name;
    }
    const parameters = { ...baseParameters(id, modelSession.database), ...(id === original.id ? original.overrides : {}) };
    fillModelParameters(parameters, id === original.id ? original.reasoningEffort || '' : '');
    renderModelMatch();
    message('model-error');
    clearValidation('model-form');
  }

  $('add-model').addEventListener('click', () => openModel());
  $('model-list').addEventListener('click', event => {
    const draft = currentDraft();
    if (!draft || busy) return;
    const move = event.target.closest('[data-move-to]');
    if (move && draft.provider.routingMode === 'split') {
      const target = move.dataset.moveTo;
      if (!API_TYPES.includes(target)) return;
      const protocols = vendors.normalizeRouting(draft.provider).modelProtocols;
      const ids = draft.provider.models.filter(model => draft.selectedModels.has(model.id) && protocols[model.id] !== target).map(model => model.id);
      if (!ids.length) return;
      draft.provider.modelProtocols = vendors.assignModels(draft.provider, ids, target);
      renderModels();
      changed();
      syncSelections(t('已将 {0} 个模型移到 {1}，已选 {2} 个模型', ids.length, PROTOCOL_NAMES[target], draft.selectedModels.size));
      const firstMoved = [...$('model-list').querySelectorAll('[data-select-model]')].find(checkbox => checkbox.dataset.selectModel === ids[0]);
      firstMoved?.focus();
      return;
    }
    const row = event.target.closest('[data-model-id]');
    if (!row) return;
    const model = draft.provider.models.find(item => item.id === row.dataset.modelId);
    if (!model) return;
    if (event.target.closest('.remove-model')) {
      draft.provider.models = draft.provider.models.filter(item => item.id !== model.id);
      delete draft.provider.modelProtocols[model.id];
      draft.selectedModels.delete(model.id);
      renderModels();
      changed();
      $('add-model').focus();
    } else if (event.target.closest('.model-open, .edit-model')) openModel(model.id);
  });
  $('model-id').addEventListener('input', changeModelId);
  $('model-id').addEventListener('change', changeModelId);
  $('effort-options').addEventListener('change', () => syncReasoning());
  $('model-extra-efforts').addEventListener('input', () => syncReasoning());
  $('cap-thinking').addEventListener('change', () => syncReasoning());
  $('reset-model').addEventListener('click', () => {
    if (!modelSession) return;
    modelSession.database = clone(state.database);
    fillModelParameters(baseParameters($('model-id').value.trim()));
    renderModelMatch();
    message('model-error');
    clearValidation('model-form');
  });
  $('model-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!modelSession || busy) return;
    clearValidation('model-form');
    const draft = drafts.get(modelSession.providerId);
    if (!draft) return;
    const id = $('model-id').value.trim();
    const name = $('model-name').value.trim();
    const automaticName = name === modelSession.automaticName;
    if (!name || (!automaticName && name.length > 200)) { formError('model-error', t('请填写显示名称，最多 200 个字符。'), 'model-name'); return; }
    if (!validId(id)) { formError('model-error', t('请填写有效的请求模型 ID，最多 512 个字符，不能包含空白字符。'), 'model-id'); return; }
    if (vendors.excludedKind(id)) { formError('model-error', t('此模型不支持聊天，请填写聊天模型的请求 ID。'), 'model-id'); return; }
    if (!modelSession.editingId && draft.provider.models.length >= 5000) { formError('model-error', t('每个供应商最多支持 5000 个模型。')); return; }
    if (draft.provider.models.some(model => model.id === id && model.id !== modelSession.editingId)) { formError('model-error', t('此请求模型 ID 已添加，请直接编辑现有模型。'), 'model-id'); return; }
    const parameters = {
      contextWindow: Number($('context-window').value), contextWindowMode: baseParameters(id).contextWindowMode, maxOutputTokens: Number($('max-output').value), ...optionalInput('max-input'), ...optionalInput('default-output', 'defaultOutputTokens'),
      toolCalling: $('cap-tools').checked, vision: $('cap-vision').checked, thinking: $('cap-thinking').checked,
      supportsReasoningEffort: readEfforts('effort-options', 'model-extra-efforts')
    };
    const problem = tokenError(parameters);
    if (problem) { formError('model-error', problem, 'max-output'); return; }
    const invalidEfforts = effortError(parameters.supportsReasoningEffort);
    if (invalidEfforts) { formError('model-error', invalidEfforts, 'model-extra-efforts'); return; }
    const reasoningEffort = $('reasoning-effort').value;
    if (reasoningEffort && (!parameters.thinking || !parameters.supportsReasoningEffort.includes(reasoningEffort))) { formError('model-error', t('请选择可用的实际推理档位。'), 'reasoning-effort'); return; }
    const overrides = {};
    const base = baseParameters(id);
    for (const field of PARAMETER_FIELDS) {
      if (field === 'defaultOutputTokens' && parameters[field] === undefined) continue;
      if (field === 'maxInputTokens' && parameters[field] === undefined) {
        if (base[field] !== undefined) overrides[field] = inputCeiling({...parameters,maxInputTokens:undefined});
      } else if (!equal(parameters[field], base[field])) overrides[field] = parameters[field];
    }
    const original = modelSession.original;
    const next = { id, name: automaticName ? '' : name, discoveredName: id === original.id ? original.discoveredName : '', overrides, ...(reasoningEffort ? { reasoningEffort } : {}) };
    const apiType = (modelSession.editingId && draft.provider.modelProtocols[modelSession.editingId]) || vendors.recommendedProtocol(id);
    const index = draft.provider.models.findIndex(model => model.id === modelSession.editingId);
    if (index >= 0) draft.provider.models[index] = next;
    else draft.provider.models.push(next);
    draft.provider.modelProtocols[id] = apiType;
    draft.provider.modelProtocols = vendors.normalizeRouting(draft.provider).modelProtocols;
    if (draft.selectedModels.delete(modelSession.editingId)) draft.selectedModels.add(id);
    $('model-dialog').close();
    changed();
    renderModels();
    syncControls();
  });

  function renderDatabaseStatus() {
    if (!databaseSession) return;
    const count = Object.keys(databaseSession.database.models).length;
    $('database-count').textContent = t('{0} 个模型 · {1}{2}', count, databaseDirty() ? t('未保存的草稿') : t('已保存'), databaseSession.conflict ? t(' · 有外部更新') : '');
    $('database-update').hidden = !databaseSession.conflict;
    unavailable($('database-save'), !databaseDirty() && !databaseSession.conflict);
  }

  function databaseRow(id, record, defaults = false) {
    const row = node('div', `database-row${defaults ? ' default-row' : ''}`);
    const button = node('button', 'database-record');
    button.type = 'button';
    button.dataset.databaseAction = 'edit';
    if (defaults) button.dataset.defaults = 'true';
    else button.dataset.entryId = id;
    const name = defaults ? t('初始配置') : recordName(record, id);
    button.setAttribute('aria-label', t('编辑{0}', name));
    const detail = defaults ? t('未知 ID 使用 · {0} 上下文 / {1} 输出\n{2}', record.contextWindow.toLocaleString(), record.maxOutputTokens.toLocaleString(), sourceNote(record)) : sourceNote(record);
    button.append(node('strong', '', name), node('small', '', detail));
    const edit = iconButton('edit', t('编辑{0}', name));
    edit.dataset.databaseAction = 'edit';
    if (defaults) edit.dataset.defaults = 'true';
    else edit.dataset.entryId = id;
    row.append(button, edit);
    if (!defaults) {
      const remove = iconButton('trash', t('删除参数 {0}', name));
      remove.dataset.databaseAction = 'delete';
      remove.dataset.entryId = id;
      row.append(remove);
    }
    return row;
  }

  function renderDatabase() {
    if (!databaseSession) return;
    const database = databaseSession.database;
    const query = $('database-search').value.trim().toLocaleLowerCase();
    const content = document.createDocumentFragment();
    content.append(databaseRow(null, database.defaults, true));
    let count = 0;
    for (const [id, record] of Object.entries(database.models)) {
      if (!`${record.name} ${id}`.toLocaleLowerCase().includes(query)) continue;
      content.append(databaseRow(id, record));
      count += 1;
    }
    if (!count) content.append(node('p', 'database-empty', query ? t('没有匹配的参数条目。') : t('暂无模型条目，可新增或导入参数库。')));
    $('database-list').replaceChildren(content);
    renderDatabaseStatus();
    syncControls();
  }

  function openDatabase() {
    if (!state || busy) return;
    databaseSession = { database: clone(state.database), baseline: clone(state.database), conflict: false };
    $('database-search').value = '';
    message('database-error');
    renderDatabase();
    showDialog('database-dialog', 'database-search');
  }

  function syncDatabasePricing() {
    const kind = $('database-pricing-kind').value;
    unavailable($('database-pricing-thresholds'), kind !== 'tiered');
    $('database-pricing-thresholds').required = kind === 'tiered';
    $('database-pricing-source').required = kind === 'tiered' || kind === 'flat';
    for (const field of ['scope', 'source', 'note', 'checked']) unavailable($(`database-pricing-${field}`), !kind);
    if (databaseEditor) {
      const pricing = readDatabasePricing();
      $('database-pricing-rates').textContent = pricingRatesText(pricing);
      $('database-pricing-rates').hidden = !pricing?.rates;
    }
  }

  function readDatabasePricing() {
    const kind = $('database-pricing-kind').value;
    if (!kind) return undefined;
    const csv = $('database-pricing-thresholds').value.trim();
    const pricing = {
      ...databaseEditor.original.contextPricing,
      kind, scope: $('database-pricing-scope').value,
      thresholds: kind === 'tiered' && csv ? csv.split(/[,，]/).map(value => /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN) : [],
      source: $('database-pricing-source').value.trim(), note: $('database-pricing-note').value.trim(),
      checkedAt: $('database-pricing-checked').value || null
    };
    const previous = databaseEditor.original.contextPricing;
    if (previous && (previous.kind !== pricing.kind || previous.scope !== pricing.scope || !equal([...previous.thresholds].sort((a,b)=>a-b), [...pricing.thresholds].sort((a,b)=>a-b)))) delete pricing.rates;
    return pricing;
  }

  function contextPricingProblem(pricing) {
    if (pricing === undefined) return null;
    if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing) || !['unknown', 'tiered', 'flat'].includes(pricing.kind)) return { text: t('Context 计费类型无效。'), field: 'database-pricing-kind' };
    if (!['direct-api', 'copilot', 'custom'].includes(pricing.scope)) return { text: t('Context 计费适用渠道无效。'), field: 'database-pricing-scope' };
    if (!Array.isArray(pricing.thresholds) || pricing.thresholds.length > 8 || pricing.thresholds.some(value => !Number.isSafeInteger(value) || value <= 0 || value > 100000000) || new Set(pricing.thresholds).size !== pricing.thresholds.length) return { text: t('Context 计费阈值最多 8 个，每项为 1–100000000 的不重复整数，用逗号分隔。'), field: 'database-pricing-thresholds' };
    if ((pricing.kind === 'tiered') !== Boolean(pricing.thresholds.length)) return { text: t('按长度分段需要至少一个阈值；未核实或不分段时阈值应为空。'), field: 'database-pricing-thresholds' };
    const source = pricing.source ?? '';
    if (typeof source !== 'string' || source.length > 4000 || (pricing.kind !== 'unknown' && !source.trim())) return { text: t('Context 计费来源最多 4000 个字符；按长度分段或不分段时必须填写。'), field: 'database-pricing-source' };
    const note = pricing.note ?? '';
    if (typeof note !== 'string' || note.length > 4000) return { text: t('Context 计费说明必须是最多 4000 个字符的文本。'), field: 'database-pricing-note' };
    if (pricing.checkedAt != null && !validDate(pricing.checkedAt)) return { text: t('请填写有效的计费核验日期（YYYY-MM-DD），或留空。'), field: 'database-pricing-checked' };
    return null;
  }

  function openDatabaseEditor(mode, id = null) {
    if (!databaseSession || busy) return;
    const database = databaseSession.database;
    const record = clone(mode === 'model' ? database.models[id] : database.defaults);
    databaseEditor = { mode, id, original: mode === 'new' ? {} : record, pricingEdited: mode === 'new' };
    $('database-editor-title').textContent = mode === 'defaults' ? t('编辑初始配置') : mode === 'new' ? t('新增模型参数') : t('编辑模型参数');
    $('database-name').value = mode === 'new' ? '' : record.name;
    $('database-name').placeholder = mode === 'defaults' ? t('初始配置（可选）') : t('模型显示名称');
    $('database-id').value = id || '';
    $('database-mapping').hidden = mode === 'defaults';
    $('database-mapping').open = false;
    $('database-context').value = record.contextWindow;
    $('database-input').value = record.maxInputTokens ?? '';
    $('database-output').value = record.maxOutputTokens;
    $('database-default-output').value = record.defaultOutputTokens ?? '';
    $('database-tools').checked = record.toolCalling;
    $('database-vision').checked = record.vision;
    $('database-thinking').checked = record.thinking;
    renderEfforts('database-efforts', record.supportsReasoningEffort);
    $('database-extra-efforts').value = '';
    $('database-source').value = mode === 'new' ? t('用户维护，未核验。') : record.source;
    $('database-verified').value = mode === 'new' ? '' : record.verifiedAt || '';
    $('database-release-field').hidden = mode === 'defaults';
    $('database-release').value = mode === 'new' || mode === 'defaults' ? '' : record.releaseDate || '';
    const pricing = mode === 'new' ? undefined : record.contextPricing;
    $('database-pricing').open = false;
    $('database-pricing-kind').value = pricing?.kind || (mode === 'new' ? 'unknown' : '');
    $('database-pricing-scope').value = pricing?.scope || 'direct-api';
    $('database-pricing-thresholds').value = pricing?.thresholds?.join(', ') || '';
    $('database-pricing-source').value = pricing?.source || '';
    $('database-pricing-note').value = pricing?.note || '';
    $('database-pricing-checked').value = pricing?.checkedAt || '';
    $('database-pricing-rates').textContent = pricingRatesText(pricing);
    $('database-pricing-rates').hidden = !pricing?.rates;
    syncDatabasePricing();
    clearValidation('database-form');
    message('database-editor-error');
    syncControls();
    showDialog('database-editor', 'database-name');
  }

  function databaseProblem(database) {
    if (!database || database.schemaVersion !== 1 || !database.models) return t('参数库格式无效。');
    if (Object.keys(database.models).length > 20000) return t('参数库最多包含 20000 个模型。');
    for (const [id, record] of [[null, database.defaults], ...Object.entries(database.models)]) {
      if (id !== null && !validId(id)) return t('参数库中存在无效的请求模型 ID。');
      if (!record || typeof record.name !== 'string' || typeof record.source !== 'string') return t('参数库中的名称与来源必须是文本。');
      if (record.name.length > 200 || record.source.length > 4000) return t('显示名称最多 200 个字符，参数来源最多 4000 个字符。');
      const problem = tokenError(record);
      if (problem) return t('{0}：{1}', id === null ? t('初始配置') : recordName(record, id), problem);
      if (['toolCalling', 'vision', 'thinking'].some(field => typeof record[field] !== 'boolean')) return t('模型能力必须为启用或停用状态。');
      const invalidEfforts = effortError(record.supportsReasoningEffort);
      if (invalidEfforts) return invalidEfforts;
      if (record.verifiedAt !== null && !validDate(record.verifiedAt)) return t('核验日期格式应为 YYYY-MM-DD。');
      if (record.releaseDate != null && !ordering.validDate(record.releaseDate)) return t('模型发布日期必须是有效的 YYYY-MM-DD 日期。');
      const pricingProblem = contextPricingProblem(record.contextPricing);
      if (pricingProblem) return t('{0}：{1}', id === null ? t('初始配置') : recordName(record, id), pricingProblem.text);
    }
    return null;
  }

  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  $('open-database').addEventListener('click', openDatabase);
  $('database-search').addEventListener('input', renderDatabase);
  $('database-add').addEventListener('click', () => openDatabaseEditor('new'));
  for (const field of ['kind', 'scope', 'thresholds', 'source', 'note', 'checked']) {
    for (const event of ['input', 'change']) $(`database-pricing-${field}`).addEventListener(event, () => {
      if (!databaseEditor || busy) return;
      databaseEditor.pricingEdited = true;
      if (field === 'kind') syncDatabasePricing();
    });
  }
  $('database-list').addEventListener('click', event => {
    const button = event.target.closest('[data-database-action]');
    if (!button || !databaseSession || busy) return;
    const id = button.dataset.entryId;
    if (button.dataset.databaseAction === 'edit') openDatabaseEditor(button.dataset.defaults ? 'defaults' : 'model', id);
    else if (own(databaseSession.database.models, id)) {
      confirmAction(t('删除模型参数'), t('从参数库草稿中删除“{0}”？使用此映射的模型将回退到初始配置，已有手动调整保留。', recordName(databaseSession.database.models[id], id)), () => {
        delete databaseSession.database.models[id];
        renderDatabase();
        $('database-search').focus();
      });
    }
  });
  $('database-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!databaseSession || !databaseEditor || busy) return;
    clearValidation('database-form');
    const { mode, id: oldId } = databaseEditor;
    const id = $('database-id').value.trim();
    const name = $('database-name').value.trim();
    if ((mode !== 'defaults' && !name) || name.length > 200) { formError('database-editor-error', t('请填写显示名称，最多 200 个字符。'), 'database-name'); return; }
    if (mode === 'new' && Object.keys(databaseSession.database.models).length >= 20000) { formError('database-editor-error', t('参数库最多包含 20000 个模型。')); return; }
    if (mode !== 'defaults' && !validId(id)) { formError('database-editor-error', t('请展开内部 ID 映射并填写有效的请求模型 ID，最多 512 个字符。'), 'database-id'); return; }
    if (mode !== 'defaults' && own(databaseSession.database.models, id) && (mode === 'new' || id !== oldId)) { formError('database-editor-error', t('此请求模型 ID 已存在，请编辑现有条目。'), 'database-id'); return; }
    const record = {
      ...databaseEditor.original,
      name, contextWindow: Number($('database-context').value), maxOutputTokens: Number($('database-output').value), ...optionalInput('database-input'), ...optionalInput('database-default-output', 'defaultOutputTokens'),
      toolCalling: $('database-tools').checked, vision: $('database-vision').checked, thinking: $('database-thinking').checked,
      supportsReasoningEffort: readEfforts('database-efforts', 'database-extra-efforts'),
      source: $('database-source').value.trim(), verifiedAt: $('database-verified').value || null,
      ...(mode === 'defaults' ? {} : { releaseDate: $('database-release').value || null })
    };
    if (!$('database-input').value.trim()) delete record.maxInputTokens;
    if (!$('database-default-output').value.trim()) delete record.defaultOutputTokens;
    if (databaseEditor.pricingEdited) {
      const pricing = readDatabasePricing();
      if (pricing === undefined) delete record.contextPricing;
      else record.contextPricing = pricing;
    }
    const pricingProblem = contextPricingProblem(record.contextPricing);
    if (pricingProblem) { formError('database-editor-error', pricingProblem.text, pricingProblem.field); return; }
    if (databaseEditor.pricingEdited && record.contextPricing) record.contextPricing.thresholds.sort((left, right) => left - right);
    const problem = tokenError(record);
    if (problem) { formError('database-editor-error', problem, 'database-output'); return; }
    const invalidEfforts = effortError(record.supportsReasoningEffort);
    if (invalidEfforts) { formError('database-editor-error', invalidEfforts, 'database-extra-efforts'); return; }
    if (record.source.length > 4000) { formError('database-editor-error', t('参数来源最多 4000 个字符。'), 'database-source'); return; }
    if (record.verifiedAt && !validDate(record.verifiedAt)) { formError('database-editor-error', t('请填写有效的核验日期。'), 'database-verified'); return; }
    if (record.releaseDate && !ordering.validDate(record.releaseDate)) { formError('database-editor-error', t('请填写有效的模型发布日期。'), 'database-release'); return; }
    if (mode === 'defaults') databaseSession.database.defaults = record;
    else {
      if (mode === 'model' && oldId !== id) delete databaseSession.database.models[oldId];
      databaseSession.database.models[id] = record;
    }
    $('database-editor').close();
    message('database-error');
    renderDatabase();
  });

  async function saveDatabase() {
    if (!databaseSession) return;
    const database = clone(databaseSession.database);
    const problem = databaseProblem(database);
    if (problem) { message('database-error', problem); return; }
    await runAction(t('正在保存参数库…'), async () => {
      const next = await request('saveDatabase', { database });
      applyState(next, { database: true });
      $('database-dialog').close();
    }, 'database-error');
  }

  async function importDatabase() {
    await runAction(t('请选择要导入的参数库文件…'), async () => {
      const previous = clone(state.database);
      const next = await request('importDatabase');
      validateState(next);
      const imported = !equal(previous, next.database);
      applyState(next, { database: imported });
    }, 'database-error');
  }

  $('database-save').addEventListener('click', () => {
    if (!databaseSession) return;
    if (databaseSession.conflict) confirmAction(t('覆盖参数库更新'), t('参数库已在其他位置修改。是否使用当前参数草稿覆盖已保存的参数库？'), () => saveDatabase());
    else void saveDatabase();
  });
  $('database-import').addEventListener('click', () => {
    confirmAction(t('导入参数库'), t('选择文件后，导入的参数库将直接保存并替换当前参数库。当前参数库草稿也将被替换；取消文件选择会保留草稿。'), () => importDatabase());
  });
  $('database-export').addEventListener('click', () => {
    if (!databaseSession) return;
    const database = clone(databaseSession.database);
    const problem = databaseProblem(database);
    if (problem) { message('database-error', problem); return; }
    void runAction(t('请选择参数库的导出位置…'), async () => { await request('exportDatabase', { database }); }, 'database-error');
  });

  async function loadState(reset = false) {
    const loaded = await runAction(t('正在加载配置…'), async () => {
      const next = await request('getState');
      applyState(next, { reset });
    }, state ? undefined : 'load-error-message');
    if (!loaded && !state) {
      $('loading-state').hidden = true;
      $('load-error').hidden = false;
    }
    syncControls();
  }

  $('retry-state').addEventListener('click', () => { void loadState(); });
  $('reload-state').addEventListener('click', () => {
    if ([...drafts.values()].some(dirty)) confirmAction(t('重新载入配置'), t('重新载入将丢弃所有供应商的未保存修改和未保存密钥，使用扩展中最新的配置。'), () => loadState(true));
    else void loadState(true);
  });
  window.addEventListener('pagehide', () => {
    for (const draft of drafts.values()) draft.apiKey = '';
    $('api-key').value = '';
    hideKey();
    for (const pending of pendingRequests.values()) clearTimeout(pending.timer);
    pendingRequests.clear();
  });

  syncControls();
  void loadState();
})();
