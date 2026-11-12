(() => {
  'use strict';

  const vscode = acquireVsCodeApi();
  const { t } = globalThis.ByokI18n;
  const $ = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const PARAMETER_FIELDS = ['contextWindow', 'maxOutputTokens', 'toolCalling', 'vision', 'thinking', 'supportsReasoningEffort'];
  const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const vendors = globalThis.ByokModelVendors;
  const API_TYPES = vendors.apiTypes;
  const ENDPOINT_FIELDS = { responses: 'responses-url', chatCompletions: 'chat-completions-url', messages: 'messages-url' };
  const PROTOCOL_NAMES = { responses: 'Responses', chatCompletions: 'Chat Completions', messages: 'Messages' };
  const modelPolicy = globalThis.ByokModelPolicy;
  const pendingRequests = new Map();
  const drafts = new Map();
  const dialogFocus = new WeakMap();
  let state = null;
  let activeId = null;
  let busy = null;
  let sequence = 0;
  let modelSession = null;
  let transferSession = null;
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
    for (const item of transferSession?.providers || []) {
      if (item.apiKey) text = text.split(item.apiKey).join(t('[密钥已隐藏]'));
      if (item.apiKey?.trim()) text = text.split(item.apiKey.trim()).join(t('[密钥已隐藏]'));
    }
    return text;
  }

  function showToast(text, error) {
    clearTimeout(toastTimer);
    const element = $('toast');
    const dialogs = [...document.querySelectorAll('dialog[open]')];
    (dialogs.at(-1) || document.body).append(element);
    element.setAttribute('role', error ? 'alert' : 'status');
    element.setAttribute('aria-live', error ? 'assertive' : 'polite');
    element.classList.toggle('error-toast', error);
    element.classList.toggle('success-toast', !error);
    element.textContent = text;
    element.hidden = false;
    toastTimer = setTimeout(() => { element.hidden = true; }, error ? 8000 : 4000);
  }

  function errorToast(text) { showToast(text, true); }
  function successToast(text) { showToast(text, false); }

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
  function baseParameters(id, database = state.database) { return own(database.models, id) ? database.models[id] : database.defaults; }
  function modelName(model, database = state.database) {
    return model.name || (own(database.models, model.id) && database.models[model.id].name) || model.id;
  }
  function recordName(record, id) { return record.name || id; }

  function validateState(next) {
    if (!next || !Array.isArray(next.providers) || !Number.isSafeInteger(next.revision) || next.revision < 0 || !next.database || next.database.schemaVersion !== 1 || !next.database.defaults || !next.database.models || Array.isArray(next.database.models)) {
      throw new Error(t('扩展返回的配置格式无效，请重新打开 BYOK Studio。'));
    }
    for (const provider of next.providers) {
      if (!provider || typeof provider.id !== 'string' || typeof provider.name !== 'string' || typeof provider.enabled !== 'boolean' || !Array.isArray(provider.models)) {
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
    if (!state || next.revision >= state.revision) {
      if (next.modelRules) vendors.configure(next.modelRules);
      state = clone(next);
    }
    const remote = new Map(state.providers.map(provider => [provider.id, provider]));
    if (acknowledgement.reset) {
      for (const draft of drafts.values()) draft.apiKey = '';
      drafts.clear();
    }
    for (const id of acknowledgement.savedIds || []) {
      const saved = remote.get(id);
      const old = drafts.get(id);
      if (old) old.apiKey = '';
      if (saved) drafts.set(saved.id, makeDraft(saved));
    }
    if (acknowledgement.deletedId) {
      const removed = drafts.get(acknowledgement.deletedId);
      if (removed) removed.apiKey = '';
      drafts.delete(acknowledgement.deletedId);
    }
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
    if (modelSession && drafts.get(modelSession.providerId)?.conflict) {
      $('model-update').hidden = false;
    }
    $('loading-state').hidden = true;
    $('load-error').hidden = true;
    $('settings-card').hidden = false;
    renderMain(previousActive !== currentDraft() || Boolean(acknowledgement.reset));
    renderUpdateBanner();
    syncControls();
  }

  function renderUpdateBanner() {
    $('update-banner').hidden = ![...drafts.values()].some(draft => draft.conflict);
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
    unavailable($('import-providers'), !state);
    unavailable($('export-providers'), !state?.providers.length);
    unavailable($('save-provider'), !draft);
    unavailable($('refresh-models'), !draft);
    if (!draft) return;
    const hasKey = state?.providers.find(item => item.id === draft.provider.id)?.hasKey === true;
    $('api-key').placeholder = hasKey ? t('留空保持已存密钥') : t('输入 API Key（可选）');
    $('refresh-models-label').textContent = t('刷新');
    $('refresh-models').title = t('获取模型并按模型系列重新分配协议，保留同 ID 模型的名称和参数设置');
  }

  function modelRow(model) {
    const draft = currentDraft();
    const name = modelName(model);
    const row = node('div', 'model-row');
    row.dataset.modelId = model.id;
    const checkbox = node('input', 'model-checkbox');
    checkbox.type = 'checkbox';
    checkbox.dataset.selectModel = model.id;
    checkbox.checked = draft.selectedModels.has(model.id);
    checkbox.setAttribute('aria-label', t('选择模型 {0}', name));
    row.append(checkbox);
    row.classList.toggle('selected', checkbox.checked);
    const open = node('button', 'model-open');
    open.type = 'button';
    open.setAttribute('aria-label', t('设置模型 {0}', name));
    open.append(node('span', 'model-label', name));
    const date = own(state.database.models, model.id) ? state.database.models[model.id].releaseDate : undefined;
    open.title = `${name}\n${model.id}\n${modelPolicy.validDate(date) ? t('发布日期：{0}', date) : t('发布日期未知')}`;
    const actions = node('span', 'model-actions');
    actions.append(iconButton('edit', t('编辑模型 {0}', name), 'edit-model'), iconButton('trash', t('移除模型 {0}', name), 'remove-model'));
    row.append(open, actions);
    return row;
  }

  function syncSelections() {
    const draft = currentDraft();
    if (!draft) return;
    const split = draft.provider.routingMode === 'split';
    const routing = vendors.normalizeRouting(draft.provider);
    const lists = split ? vendors.protocolLists(draft.provider) : [];
    const selected = lists.map(list => ({ ...list, count: list.models.filter(model => draft.selectedModels.has(model.id)).length }));
    const total = draft.provider.models.filter(model => draft.selectedModels.has(model.id)).length;
    $('delete-selected-models').hidden = !total;
    unavailable($('delete-selected-models'), !total);
    const unifiedSelectAll = $('select-all-unified');
    unifiedSelectAll.checked = !split && total > 0 && total === draft.provider.models.length;
    unifiedSelectAll.indeterminate = !split && total > 0 && total < draft.provider.models.length;
    unavailable(unifiedSelectAll, split || !draft.provider.models.length);
    for (const { apiType, models, count } of selected) {
      const selectAll = $(`select-all-${apiType}`);
      selectAll.checked = models.length > 0 && count === models.length;
      selectAll.indeterminate = count > 0 && count < models.length;
      unavailable(selectAll, !models.length);
      const incoming = draft.provider.models.filter(model => draft.selectedModels.has(model.id) && vendors.routeForModel(draft.provider, model.id, routing).apiType !== apiType).length;
      const target = $(`move-to-${apiType}`);
      target.hidden = !total;
      target.querySelector('span').textContent = t('移到这里');
      const label = t('移到 {0}', PROTOCOL_NAMES[apiType]);
      target.setAttribute('aria-label', label);
      target.title = label;
      unavailable(target, !incoming);
      target.closest('.protocol-controls').classList.toggle('transfer-target', incoming > 0);
      $(`protocol-card-${apiType}`).classList.toggle('transfer-target', incoming > 0);
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
    const scroller = node('div', 'model-scroll');
    scroller.id = 'model-scroll';
    scroller.tabIndex = 0;
    scroller.setAttribute('role', 'region');
    scroller.setAttribute('aria-labelledby', 'models-heading');
    const split = draft.provider.routingMode === 'split';
    $('unified-model-selection').hidden = split;
    $('model-list').classList.toggle('split-models', split);
    const total = draft.provider.models.length;
    $('model-total').textContent = `${total}`;
    $('model-total').setAttribute('aria-label', t('共 {0} 个模型', total));
    if (split) {
      const cards = node('div', 'protocol-cards');
      cards.setAttribute('aria-hidden', 'true');
      const headers = node('div', 'protocol-headers');
      for (const { apiType, models } of vendors.protocolLists(draft.provider)) {
        const card = node('div', 'protocol-card');
        card.id = `protocol-card-${apiType}`;
        cards.append(card);
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
        const list = node('section', 'protocol-models');
        list.dataset.protocol = apiType;
        list.setAttribute('aria-labelledby', `protocol-heading-${apiType}`);
        for (const model of models) list.append(modelRow(model));
        if (!models.length) list.append(node('p', 'empty-models', t('暂无模型')));
        const controls = node('div', 'protocol-controls');
        controls.append(header, endpoint, move);
        headers.append(controls);
        scroller.append(list);
      }
      content.append(cards, headers);
    } else {
      const models = draft.provider.models.filter(model => !vendors.excludedKind(model.id));
      for (const model of models) scroller.append(modelRow(model));
      if (!models.length) scroller.append(node('p', 'empty-models', t('暂无模型')));
    }
    content.append(scroller);
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
        $('api-key').value = draft.apiKey;
        clearValidation('provider-form');
        message('provider-error');
      }
      renderRouting();
      renderModels();
    } else {
      $('api-key').value = '';
    }
    renderStatus();
    renderUpdateBanner();
    syncControls();
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
    if (!Number.isSafeInteger(parameters.contextWindow) || !Number.isSafeInteger(parameters.maxOutputTokens) || parameters.contextWindow <= 0 || parameters.maxOutputTokens <= 0 || parameters.contextWindow > 100000000 || parameters.maxOutputTokens > 100000000) return t('Context 和 Output 必须是 1–100000000 的整数。');
    if (parameters.maxOutputTokens >= parameters.contextWindow) return t('Output 必须小于 Context。');
    return null;
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
    const routing = vendors.normalizeRouting(provider);
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
        const route = vendors.routeForModel(provider, model.id, routing);
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
      if (dialog.open) return;
      if (dialog.id === 'model-dialog') modelSession = null;
      if (dialog.id === `${transferSession?.mode}-dialog`) transferSession = null;
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
  $('confirm-action').addEventListener('click', () => {
    const action = pendingConfirm;
    pendingConfirm = null;
    $('confirm-dialog').close();
    if (action) action();
  });

  function addProvider() {
    if (!state || busy) return;
    const provider = { id: `provider-${crypto.randomUUID()}`, name: t('新供应商'), ...vendors.normalizeRouting({}), enabled: true, models: [] };
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
      applyState(next, { savedIds: [id] });
      $('api-key').value = currentDraft()?.apiKey || '';
      successToast(t('供应商已保存。'));
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
      target.provider.modelProtocols = vendors.normalizeRouting({ ...target.provider, modelProtocols: {} }).modelProtocols;
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
  $('api-key').addEventListener('input', event => { if (currentDraft()) { currentDraft().apiKey = event.target.value; changed(); } });
  function selectionChanged(event) {
    endpointChanged(event);
    const draft = currentDraft();
    if (!draft || busy) return;
    const checkbox = event.target.closest('[data-select-model]');
    const selectAll = event.target.closest('[data-select-all]');
    if (checkbox) {
      if (checkbox.checked) draft.selectedModels.add(checkbox.dataset.selectModel);
      else draft.selectedModels.delete(checkbox.dataset.selectModel);
    } else if (selectAll) {
      const models = selectAll.dataset.selectAll === 'unified' ? draft.provider.models
        : vendors.protocolLists(draft.provider).find(list => list.apiType === selectAll.dataset.selectAll)?.models || [];
      for (const model of models) {
        if (selectAll.checked) draft.selectedModels.add(model.id);
        else draft.selectedModels.delete(model.id);
      }
    }
    syncSelections();
    syncControls();
  }
  $('model-list').addEventListener('change', selectionChanged);
  $('select-all-unified').addEventListener('change', selectionChanged);
  function focusModelList() {
    const scroller = $('model-scroll');
    scroller.focus();
    if (document.activeElement !== scroller) $('model-list').focus();
  }
  $('delete-selected-models').addEventListener('click', () => {
    const draft = currentDraft();
    if (!draft || busy) return;
    const ids = new Set(draft.provider.models.filter(model => draft.selectedModels.has(model.id)).map(model => model.id));
    if (!ids.size) return;
    confirmAction(t('删除所选模型'), t('从当前草稿中删除已选的 {0} 个模型？保存供应商后生效。', ids.size), () => {
      if (currentDraft() !== draft) return;
      draft.provider.models = draft.provider.models.filter(model => !ids.has(model.id));
      for (const id of ids) delete draft.provider.modelProtocols[id];
      draft.selectedModels.clear();
      renderModels();
      changed();
      focusModelList();
    });
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

  function readEfforts() {
    return [...$('effort-options').querySelectorAll('input:checked')].map(input => input.value);
  }

  function syncReasoning(selected = $('reasoning-effort').value) {
    const declared = readEfforts().filter(validEffort);
    const id = $('model-id').value.trim();
    const parameters = { ...baseParameters(id), thinking: $('cap-thinking').checked, supportsReasoningEffort: declared };
    const provider = drafts.get(modelSession.providerId).provider;
    const apiType = provider.routingMode === 'unified' ? provider.unified.apiType : $('model-protocol').value || vendors.recommendedProtocol(id);
    const projection = modelPolicy.projectEfforts(parameters, apiType);
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
  }

  function fillModelParameters(parameters, selected = '') {
    $('context-window').value = parameters.contextWindow;
    $('max-output').value = parameters.maxOutputTokens;
    $('cap-tools').checked = parameters.toolCalling;
    $('cap-vision').checked = parameters.vision;
    $('cap-thinking').checked = parameters.thinking;
    renderEfforts('effort-options', parameters.supportsReasoningEffort);
    syncReasoning(selected);
    syncControls();
  }

  function openModel(id = null) {
    const draft = currentDraft();
    if (!draft || busy) return;
    const model = id ? draft.provider.models.find(item => item.id === id) : { id: '', name: '', discoveredName: '', overrides: {} };
    if (!model) return;
    const initialProtocol = id && own(draft.provider.modelProtocols, id) ? draft.provider.modelProtocols[id] : vendors.recommendedProtocol(model.id);
    modelSession = { providerId: draft.provider.id, original: clone(model), editingId: id, requestId: model.id, automaticName: model.name ? null : (model.id ? modelName(model) : ''), protocolTouched: Boolean(id && own(draft.provider.modelProtocols, id)) };
    $('model-title').textContent = id ? t('模型设置') : t('添加模型');
    $('apply-model').textContent = id ? t('应用到草稿') : t('添加');
    $('model-update').hidden = true;
    $('model-id').value = model.id;
    $('model-name').value = model.id ? modelName(model) : '';
    $('model-protocol').value = initialProtocol;
    $('model-protocol-field').hidden = draft.provider.routingMode === 'unified';
    unavailable($('model-protocol'), draft.provider.routingMode === 'unified');
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
    fillModelParameters({ ...baseParameters(model.id), ...model.overrides }, model.reasoningEffort || '');
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
      const name = id ? modelName({ id, name: '', discoveredName }) : '';
      $('model-name').value = name;
      modelSession.automaticName = name;
    }
    if (!modelSession.protocolTouched) $('model-protocol').value = vendors.recommendedProtocol(id);
    const parameters = { ...baseParameters(id), ...(id === original.id ? original.overrides : {}) };
    fillModelParameters(parameters, id === original.id ? original.reasoningEffort || '' : '');
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
  $('model-protocol').addEventListener('change', () => {
    if (!modelSession || busy) return;
    modelSession.protocolTouched = true;
    syncReasoning();
  });
  $('effort-options').addEventListener('change', () => syncReasoning());
  $('cap-thinking').addEventListener('change', () => syncReasoning());
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
      contextWindow: Number($('context-window').value), maxOutputTokens: Number($('max-output').value),
      toolCalling: $('cap-tools').checked, vision: $('cap-vision').checked, thinking: $('cap-thinking').checked,
      supportsReasoningEffort: readEfforts()
    };
    const problem = tokenError(parameters);
    if (problem) { formError('model-error', problem, 'max-output'); return; }
    const invalidEfforts = effortError(parameters.supportsReasoningEffort);
    if (invalidEfforts) { formError('model-error', invalidEfforts); return; }
    const reasoningEffort = $('reasoning-effort').value;
    if (reasoningEffort && (!parameters.thinking || !parameters.supportsReasoningEffort.includes(reasoningEffort))) { formError('model-error', t('请选择可用的实际推理档位。'), 'reasoning-effort'); return; }
    const overrides = {};
    const base = baseParameters(id);
    for (const field of PARAMETER_FIELDS) {
      if (!equal(parameters[field], base[field])) overrides[field] = parameters[field];
    }
    const original = modelSession.original;
    const next = { id, name: automaticName ? '' : name, discoveredName: id === original.id ? original.discoveredName : '', overrides, ...(reasoningEffort ? { reasoningEffort } : {}) };
    const apiType = draft.provider.routingMode === 'split' ? $('model-protocol').value : (modelSession.editingId && draft.provider.modelProtocols[modelSession.editingId]) || vendors.recommendedProtocol(id);
    if (!API_TYPES.includes(apiType)) { formError('model-error', t('请选择有效的请求协议。'), 'model-protocol'); return; }
    const index = draft.provider.models.findIndex(model => model.id === modelSession.editingId);
    if (index >= 0) draft.provider.models[index] = next;
    else draft.provider.models.push(next);
    if (modelSession.editingId && modelSession.editingId !== id) delete draft.provider.modelProtocols[modelSession.editingId];
    draft.provider.modelProtocols[id] = apiType;
    draft.provider.modelProtocols = vendors.normalizeRouting(draft.provider).modelProtocols;
    if (draft.selectedModels.delete(modelSession.editingId)) draft.selectedModels.add(id);
    $('model-dialog').close();
    changed();
    renderModels();
    syncControls();
  });

  function updateTransferSelection() {
    const { mode, providers, selected } = transferSession;
    const count = selected.size, total = providers.length;
    const selectAll = $(`${mode}-select-all`);
    selectAll.checked = total > 0 && count === total;
    selectAll.indeterminate = count > 0 && count < total;
    unavailable(selectAll, !total);
    for (const input of $(`${mode}-provider-list`).querySelectorAll('[data-transfer-id]')) {
      input.checked = selected.has(input.dataset.transferId);
      input.closest('.transfer-item').classList.toggle('selected', input.checked);
    }
    if (mode === 'export') {
      unavailable($('export-clipboard'), !count);
      unavailable($('export-file'), !count);
    } else {
      $('import-summary').textContent = t('已选 {0} / {1}', count, total);
      unavailable($('apply-import'), !count);
    }
    syncControls();
  }

  function renderTransferDialog() {
    const { mode, providers } = transferSession;
    const content = document.createDocumentFragment();
    for (const provider of providers) {
      const label = node('label', 'transfer-item');
      const main = node('span', 'transfer-item-main');
      const input = node('input');
      input.type = 'checkbox';
      input.dataset.transferId = provider.id;
      main.append(input, node('span', 'transfer-item-name', provider.name));
      const meta = node('span', 'transfer-item-meta');
      meta.append(node('span', '', t('{0} 个模型', provider.models.length)));
      if (mode === 'import' && state.providers.some(item => item.id === provider.id || item.name === provider.name)) {
        meta.append(node('span', 'transfer-badge', t('更新已有')));
      }
      label.append(main, meta);
      content.append(label);
    }
    $(`${mode}-provider-list`).replaceChildren(content);
    if (mode === 'import') {
      $('import-selection-section').hidden = !providers.length;
      $('import-empty').hidden = Boolean(providers.length);
    }
    updateTransferSelection();
  }

  function openTransferDialog(mode) {
    if (!state || busy || (mode === 'export' && !state.providers.length)) return;
    const providers = mode === 'export' ? state.providers : [];
    transferSession = { mode, providers, selected: new Set(providers.map(provider => provider.id)) };
    message(`${mode}-error`);
    renderTransferDialog();
    showDialog(`${mode}-dialog`, mode === 'export' ? 'export-file' : 'import-from-clipboard');
  }

  async function submitExport(target) {
    if (transferSession?.mode !== 'export' || busy) return;
    const ids = [...transferSession.selected];
    if (!ids.length) return;
    await runAction(t('正在导出供应商…'), async () => {
      const result = await request('exportProviders', { ids, target });
      if (result?.canceled) return;
      $('export-dialog').close();
      successToast(target === 'clipboard' ? t('已复制 {0} 个供应商到剪贴板。', ids.length) : t('已导出 {0} 个供应商。', ids.length));
    }, 'export-error');
  }

  async function loadImportSource(source) {
    if (transferSession?.mode !== 'import' || busy) return;
    await runAction(t('正在读取导入配置…'), async () => {
      const result = await request('readImportSource', { source });
      if (result?.canceled) return;
      if (!result || !Array.isArray(result.providers) || !result.providers.length) {
        throw new Error(t('未读取到有效的配置内容。'));
      }
      transferSession.providers = result.providers;
      transferSession.selected = new Set(result.providers.map(provider => provider.id));
      renderTransferDialog();
    }, 'import-error');
  }

  async function applyImport() {
    if (transferSession?.mode !== 'import' || busy) return;
    const chosen = transferSession.providers.filter(provider => transferSession.selected.has(provider.id));
    if (!chosen.length) return;
    await runAction(t('正在导入供应商…'), async () => {
      const result = await request('importProviders', { providers: chosen });
      applyState(result.state, { savedIds: result.importedIds });
      $('import-dialog').close();
      successToast(t('已导入 {0} 个供应商。', chosen.length));
    }, 'import-error');
  }

  for (const mode of ['export', 'import']) {
    $(`${mode}-providers`).addEventListener('click', () => openTransferDialog(mode));
    $(`${mode}-select-all`).addEventListener('change', event => {
      if (transferSession?.mode !== mode || busy) return;
      transferSession.selected = event.target.checked ? new Set(transferSession.providers.map(item => item.id)) : new Set();
      updateTransferSelection();
    });
    $(`${mode}-provider-list`).addEventListener('change', event => {
      const input = event.target.closest('[data-transfer-id]');
      if (!input || transferSession?.mode !== mode || busy) return;
      if (input.checked) transferSession.selected.add(input.dataset.transferId);
      else transferSession.selected.delete(input.dataset.transferId);
      updateTransferSelection();
    });
  }
  $('export-clipboard').addEventListener('click', () => { void submitExport('clipboard'); });
  $('export-file').addEventListener('click', () => { void submitExport('file'); });

  $('import-from-clipboard').addEventListener('click', () => { void loadImportSource('clipboard'); });
  $('import-from-file').addEventListener('click', () => { void loadImportSource('file'); });
  $('apply-import').addEventListener('click', () => { void applyImport(); });

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
    transferSession = null;
    $('api-key').value = '';
    for (const pending of pendingRequests.values()) clearTimeout(pending.timer);
    pendingRequests.clear();
  });

  syncControls();
  void loadState();
})();
