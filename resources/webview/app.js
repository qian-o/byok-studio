(() => {
  'use strict';

  const vscode = acquireVsCodeApi();
  const { t } = globalThis.ByokI18n;
  const routing = globalThis.ByokRouting;
  const $ = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  const PARAMETER_FIELDS = ['contextWindow', 'maxOutputTokens', 'toolCalling', 'vision', 'thinking', 'supportsReasoningEffort'];
  const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const API_TYPES = routing.apiTypes;
  const ENDPOINT_FIELDS = { responses: 'responses-url', chatCompletions: 'chat-completions-url', messages: 'messages-url' };
  const PROTOCOL_NAMES = { responses: 'Responses', chatCompletions: 'Chat Completions', messages: 'Messages' };

  const pendingRequests = new Map();
  const drafts = new Map();
  const dirtyStates = new Map();
  const dialogFocus = new WeakMap();

  let state = null;
  let activeId = null;
  let activeGroups = new Map();
  let busy = null;
  let sequence = 0;
  let datalistModelsRef = null;
  let modelSession = null;
  let transferSession = null;
  let providerEdit = null;
  let pendingConfirm = null;
  let toastTimer;
  let renderedGroupId = null;

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
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
    const button = node('button', `icon-button ${className}`.trim());
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.append(icon(name));
    return button;
  }

  function message(targetId, text = '') {
    const el = $(targetId);
    el.textContent = text;
    el.hidden = !text;
  }

  function safeError(error) {
    let text = error instanceof Error ? error.message : typeof error === 'string' ? error : t('操作失败，请重试。');
    for (const draft of drafts.values()) {
      for (const secret of [draft.apiKey, draft.apiKey.trim()].filter(Boolean)) {
        text = text.split(secret).join(t('[密钥已隐藏]'));
      }
    }
    for (const item of transferSession?.providers || []) {
      for (const group of item.groups || []) {
        for (const secret of [group.apiKey, group.apiKey?.trim()].filter(Boolean)) {
          text = text.split(secret).join(t('[密钥已隐藏]'));
        }
      }
    }
    return text;
  }

  function showToast(text, isError = false) {
    clearTimeout(toastTimer);
    const el = $('toast');
    const openDialogs = [...document.querySelectorAll('dialog[open]')];
    (openDialogs.at(-1) || document.body).append(el);
    el.setAttribute('role', isError ? 'alert' : 'status');
    el.setAttribute('aria-live', isError ? 'assertive' : 'polite');
    el.classList.toggle('error-toast', isError);
    el.classList.toggle('success-toast', !isError);
    el.textContent = text;
    el.hidden = false;
    toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 8000 : 3500);
  }

  function request(command, payload) {
    const id = `rpc-${Date.now()}-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(t('操作超时，请重试。')));
      }, 120000);
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
    if (!incoming || typeof incoming !== 'object' || typeof incoming.id !== 'string' || typeof incoming.ok !== 'boolean') return;
    const pending = pendingRequests.get(incoming.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRequests.delete(incoming.id);
    if (incoming.ok) pending.resolve(incoming.data);
    else pending.reject(new Error(typeof incoming.error === 'string' ? incoming.error : t('操作失败，请重试。')));
  });

  function unavailable(element, value) {
    element.dataset.unavailable = String(Boolean(value));
    element.disabled = Boolean(busy) || Boolean(value) || (!state && !element.hasAttribute('data-initial-action'));
  }

  function syncControls() {
    for (const element of document.querySelectorAll('button, input, select, textarea, fieldset')) {
      element.disabled = Boolean(busy) || element.dataset.unavailable === 'true' || (!state && !element.hasAttribute('data-initial-action'));
    }
    $('studio').setAttribute('aria-busy', String(Boolean(busy) || !state));
    $('request-status').textContent = busy || '';
  }

  async function runAction(label, action, errorTarget, controlId) {
    if (busy) return false;
    const focused = document.activeElement;
    busy = label;
    if (controlId) $(controlId).setAttribute('aria-busy', 'true');
    $('toast').hidden = true;
    syncControls();
    if (errorTarget) message(errorTarget);
    try {
      await action();
      return true;
    } catch (error) {
      const text = safeError(error);
      if (errorTarget) message(errorTarget, text);
      else showToast(text, true);
      return false;
    } finally {
      busy = null;
      if (controlId) $(controlId).removeAttribute('aria-busy');
      renderStatus();
      syncControls();
      if (document.activeElement === document.body && focused?.isConnected && !focused.disabled) {
        focused.focus({ preventScroll: true });
      }
    }
  }

  function sanitizeProvider(provider) {
    return { id: provider.id, name: provider.name };
  }

  function sanitizeGroup(group) {
    return {
      id: group.id,
      name: group.name || '',
      ...routing.normalizeRouting(group),
      models: (group.models || []).filter(m => !routing.isExcludedModel(m.id)).map(model => ({
        id: model.id,
        name: model.name || '',
        overrides: Object.fromEntries(
          PARAMETER_FIELDS.filter(field => own(model.overrides || {}, field)).map(field => [field, clone(model.overrides[field])])
        ),
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
      })),
      officialName: group.officialName || ''
    };
  }

  function prepareDraft(provider, group) {
    const config = sanitizeGroup(group);
    config.name = config.name.trim();
    config.unified.url = config.unified.url.trim();
    for (const apiType of API_TYPES) config.endpoints[apiType] = config.endpoints[apiType].trim();
    const info = sanitizeProvider(provider);
    info.name = info.name.trim();
    return { provider: info, group: config };
  }

  function comparableGroup(group) {
    const { officialName: _officialName, ...config } = group;
    return config;
  }

  function makeDraft(provider, group, saved = true) {
    const prepared = prepareDraft(provider, group);
    const config = prepared.group;
    const previous = drafts.get(group.id);
    const modelIds = new Set(config.models.map(model => model.id));
    return {
      provider: prepared.provider,
      baselineProvider: saved ? clone(prepared.provider) : null,
      group: config,
      baseline: saved ? clone(config) : null,
      hasKey: group.hasKey === true,
      apiKey: '',
      selectedModels: new Set([...(previous?.selectedModels || [])].filter(id => modelIds.has(id))),
      scroll: previous?.scroll || {}
    };
  }

  function currentDraft() { return drafts.get(activeId); }
  function isDirty(draft) {
    if (dirtyStates.has(draft)) return dirtyStates.get(draft);
    const normalized = prepareDraft(draft.provider, draft.group);
    const dirty = !draft.baseline || !equal(normalized.provider, draft.baselineProvider)
      || !equal(comparableGroup(normalized.group), comparableGroup(draft.baseline)) || Boolean(draft.apiKey.trim());
    dirtyStates.set(draft, dirty);
    return dirty;
  }
  function groupName(draft) { return draft.group.name.trim() || t('默认'); }
  function modelLabel(model) { return routing.displayModelName(state.database, model); }
  function settleProviderRename(rerender = false) {
    if (!providerEdit) return;
    const target = [...drafts.values()].find(item => item.provider.id === providerEdit.id);
    if (target) {
      const nextName = providerNameProblem(target.provider) ? providerEdit.originalName : target.provider.name.trim();
      setProviderName(providerEdit.id, nextName);
      dirtyStates.clear();
    }
    providerEdit = null;
    if (rerender) changed(true);
  }
  function switchGroup(id) {
    settleProviderRename();
    activeId = id;
    const draft = currentDraft();
    if (draft) activeGroups.set(draft.provider.id, id);
  }
  function uniqueGroupName(providerId) {
    const names = new Set([...drafts.values()]
      .filter(draft => draft.provider.id === providerId)
      .map(draft => draft.group.name.trim()));
    const base = t('新分组');
    if (!names.has(base)) return base;
    for (let index = 2; index < 500; index++) {
      const candidate = `${base} ${index}`;
      if (!names.has(candidate)) return candidate;
    }
    return `${base} ${Date.now()}`;
  }

  function uniqueProviderName() {
    const names = new Set([...drafts.values()].map(draft => draft.provider.name.trim()));
    const base = t('新供应商');
    let name = base;
    for (let index = 2; names.has(name); index++) name = `${base} ${index}`;
    return name;
  }

  function ensureModelDatalist() {
    const models = state?.database?.models;
    if (!models || datalistModelsRef === models) return;
    datalistModelsRef = models;
    const rankId = id => (/[/:@]/.test(id) ? 1 : 0);
    const entries = Object.entries(models)
      .filter(([id]) => !routing.isExcludedModel(id))
      .sort(([a], [b]) => {
        const rankDiff = rankId(a) - rankId(b);
        if (rankDiff) return rankDiff;
        const al = a.toLowerCase();
        const bl = b.toLowerCase();
        return al < bl ? -1 : al > bl ? 1 : (a < b ? -1 : a > b ? 1 : 0);
      });
    const fragment = document.createDocumentFragment();
    for (const [id, record] of entries) {
      const option = node('option');
      option.value = id;
      option.label = record.name || id;
      fragment.append(option);
    }
    $('model-id-options').replaceChildren(fragment);
  }

  function applyState(next, options = {}) {
    if (!next || !Array.isArray(next.providers) || !next.database?.models) {
      throw new Error(t('扩展返回的配置格式无效，请重新打开 BYOK Studio。'));
    }
    const previousDraft = currentDraft();
    rememberModelScroll();
    dirtyStates.clear();
    state = { providers: clone(next.providers), database: next.database };
    const savedMap = new Map();
    for (const provider of state.providers) {
      for (const group of provider.groups) savedMap.set(group.id, { provider, group });
    }
    const savedProvider = state.providers.find(provider => provider.id === options.savedProviderId);
    if (savedProvider) {
      for (const item of drafts.values()) {
        if (item.provider.id !== savedProvider.id) continue;
        item.provider = sanitizeProvider(savedProvider);
        item.baselineProvider = clone(item.provider);
        if (item.baseline) {
          item.baseline.officialName = routing.officialGroupName(savedProvider.name, item.baseline.name);
          item.group.officialName = savedMap.get(item.group.id)?.group.officialName || item.group.officialName;
        }
      }
    }
    for (const id of options.savedIds || []) {
      const old = drafts.get(id);
      if (old) old.apiKey = '';
      const fresh = savedMap.get(id);
      if (fresh) drafts.set(id, makeDraft(fresh.provider, fresh.group, true));
    }
    if (options.deletedId) {
      const removed = drafts.get(options.deletedId);
      if (removed) removed.apiKey = '';
      drafts.delete(options.deletedId);
    }
    if (options.deletedProviderId) {
      for (const [id, draft] of drafts) {
        if (draft.provider.id !== options.deletedProviderId) continue;
        draft.apiKey = '';
        drafts.delete(id);
      }
      activeGroups.delete(options.deletedProviderId);
    }
    if (options.savedProviderId || options.deletedProviderId === providerEdit?.id) providerEdit = null;

    for (const [id, draft] of drafts) {
      if (!draft.baseline) continue;
      const remote = savedMap.get(id);
      if (!remote) {
        if (!isDirty(draft)) drafts.delete(id);
      } else if (!isDirty(draft)) {
        drafts.set(id, makeDraft(remote.provider, remote.group, true));
      } else {
        draft.hasKey = remote.group.hasKey === true;
      }
    }

    for (const provider of state.providers) {
      for (const group of provider.groups) {
        if (!drafts.has(group.id)) drafts.set(group.id, makeDraft(provider, group, true));
      }
    }

    if (options.focusId && drafts.has(options.focusId)) activeId = options.focusId;
    else if (!drafts.has(activeId)) {
      const previousProviderId = previousDraft?.provider.id;
      const replacement = [...drafts.values()].find(draft => draft.provider.id === previousProviderId);
      activeId = replacement?.group.id || drafts.keys().next().value || null;
    }
    if (currentDraft()) activeGroups.set(currentDraft().provider.id, activeId);
    for (const [id, draft] of drafts) {
      if (!isDirty(draft) && !savedMap.has(id)) drafts.delete(id);
    }

    $('loading-state').hidden = true;
    $('load-error').hidden = true;
    $('settings-card').hidden = false;
    renderMain(previousDraft !== currentDraft() || Boolean(options.savedIds?.includes(activeId)));
    syncControls();
  }

  function renderSidebar() {
    const scrollLeft = $('provider-list').scrollLeft;
    const nameField = $('provider-name-field');
    nameField.hidden = true;
    $('provider-list').before(nameField);
    const activeProviderId = currentDraft()?.provider.id;
    if (providerEdit?.id !== activeProviderId) providerEdit = null;
    const providers = new Map();
    for (const [id, draft] of drafts) {
      if (!draft.baseline && !isDirty(draft)) continue;
      let provider = providers.get(draft.provider.id);
      if (!provider) {
        provider = { draft, entries: [] };
        providers.set(draft.provider.id, provider);
      }
      provider.entries.push([id, draft]);
    }
    const content = document.createDocumentFragment();
    for (const [providerId, { draft: first, entries }] of providers) {
      const name = first.provider.name.trim() || t('新供应商');
      const dirty = entries.some(([, draft]) => isDirty(draft));
      const active = providerId === activeProviderId;
      const editing = providerEdit?.id === providerId;
      const tab = node('div', `provider-tab${active ? ' active' : ''}`);
      tab.dataset.providerTab = providerId;
      if (editing) {
        nameField.hidden = false;
        tab.append(nameField);
      } else {
        const button = node('button', 'provider-nav');
        button.type = 'button';
        button.dataset.providerId = providerId;
        button.setAttribute('aria-label', name);
        button.title = dirty ? `${name} (${t('未保存修改')})` : name;
        if (active) button.setAttribute('aria-current', 'page');
        const avatar = node('span', 'provider-avatar', ([...name][0] || '?').toUpperCase());
        avatar.setAttribute('aria-hidden', 'true');
        button.append(avatar, node('span', 'provider-label', name));
        tab.append(button);
      }
      if (dirty) {
        const dot = node('span', 'dirty-dot');
        dot.setAttribute('aria-hidden', 'true');
        tab.append(dot);
      }
      if (active) {
        const actions = node('span', 'provider-actions');
        if (editing) {
          const finish = iconButton('check', t('完成重命名'));
          finish.dataset.providerAction = 'finish';
          const cancel = iconButton('close', t('取消重命名'));
          cancel.dataset.providerAction = 'cancel';
          actions.append(finish, cancel);
        } else {
          const rename = iconButton('edit', t('重命名供应商'));
          rename.dataset.providerAction = 'rename';
          const remove = iconButton('trash', t('删除供应商'), 'remove-provider');
          remove.dataset.providerAction = 'delete';
          actions.append(rename, remove);
        }
        tab.append(actions);
      }
      content.append(tab);
    }
    $('provider-list').replaceChildren(content);
    $('provider-list').scrollLeft = scrollLeft;
  }

  function renderGroups() {
    const scrollTop = $('group-list').scrollTop;
    const scrollLeft = $('group-list').scrollLeft;
    const draft = currentDraft();
    const content = document.createDocumentFragment();
    if (draft) {
      for (const [id, item] of drafts) {
        if (item.provider.id !== draft.provider.id || (!item.baseline && !isDirty(item))) continue;
        const name = groupName(item);
        const button = node('button', `group-nav${id === activeId ? ' active' : ''}`);
        button.type = 'button';
        button.dataset.groupId = id;
        button.title = `${t('VS Code 名称：{0}', item.group.officialName || routing.officialGroupName(item.provider.name, item.group.name))}${isDirty(item) ? `\n${t('未保存修改')}` : ''}`;
        if (id === activeId) button.setAttribute('aria-current', 'page');
        button.append(node('span', 'group-label', name), node('span', 'group-count', String(item.group.models.length)));
        if (isDirty(item)) {
          const dot = node('span', 'dirty-dot');
          dot.setAttribute('aria-label', t('未保存修改'));
          button.append(dot);
        }
        content.append(button);
      }
    }
    $('group-list').replaceChildren(content);
    $('group-list').scrollTop = scrollTop;
    $('group-list').scrollLeft = scrollLeft;
  }

  function syncDraftNavigation() {
    const providers = new Map();
    for (const draft of drafts.values()) {
      const entry = providers.get(draft.provider.id) || { name: draft.provider.name, dirty: false };
      entry.dirty ||= isDirty(draft);
      providers.set(draft.provider.id, entry);
    }
    for (const tab of $('provider-list').children) {
      const provider = providers.get(tab.dataset.providerTab);
      if (!provider) continue;
      const name = provider.name.trim() || t('新供应商');
      const button = tab.querySelector('[data-provider-id]');
      if (button) {
        button.setAttribute('aria-label', name);
        button.title = provider.dirty ? `${name} (${t('未保存修改')})` : name;
        button.querySelector('.provider-label').textContent = name;
        button.querySelector('.provider-avatar').textContent = ([...name][0] || '?').toUpperCase();
      }
      const dot = tab.querySelector('.dirty-dot');
      if (provider.dirty && !dot) {
        const next = node('span', 'dirty-dot');
        next.setAttribute('aria-hidden', 'true');
        tab.insertBefore(next, tab.querySelector('.provider-actions'));
      } else if (!provider.dirty) dot?.remove();
    }
    for (const button of $('group-list').children) {
      const draft = drafts.get(button.dataset.groupId);
      if (!draft) continue;
      const dirty = isDirty(draft);
      button.querySelector('.group-label').textContent = groupName(draft);
      button.querySelector('.group-count').textContent = String(draft.group.models.length);
      button.title = `${t('VS Code 名称：{0}', draft.group.officialName || routing.officialGroupName(draft.provider.name, draft.group.name))}${dirty ? `\n${t('未保存修改')}` : ''}`;
      const dot = button.querySelector('.dirty-dot');
      if (dirty && !dot) {
        const next = node('span', 'dirty-dot');
        next.setAttribute('aria-label', t('未保存修改'));
        button.append(next);
      } else if (!dirty) dot?.remove();
    }
  }

  function renderStatus() {
    const draft = currentDraft();
    const problem = draft ? submissionProblem(prepareGroupSubmission(draft)) : null;
    const invalidKey = draft && draft.apiKey.length > 16000;
    unavailable($('import-providers'), !state);
    unavailable($('export-providers'), !state?.providers.length);
    unavailable($('save-group'), !draft || !isDirty(draft) || Boolean(problem) || invalidKey);
    unavailable($('refresh-models'), !draft);
    unavailable($('add-group'), !draft);
    if (!draft) return;
    if (problem?.field) $(problem.field).setAttribute('aria-invalid', 'true');
    if (invalidKey) $('api-key').setAttribute('aria-invalid', 'true');
    const tab = $('provider-list').querySelector('.provider-tab.active');
    if (tab) tab.classList.toggle('invalid', problem?.field === 'provider-name');
    $('api-key').placeholder = draft.hasKey ? t('留空保持已存密钥') : t('输入 API Key（可选）');
    $('refresh-models').title = t('刷新模型并按系列分组');
  }

  function modelRow(model) {
    const draft = currentDraft();
    const name = modelLabel(model);
    const row = node('div', 'model-row');
    row.dataset.modelId = model.id;

    const checkbox = node('input', 'model-checkbox');
    checkbox.type = 'checkbox';
    checkbox.dataset.selectModel = model.id;
    checkbox.checked = draft.selectedModels.has(model.id);
    checkbox.setAttribute('aria-label', t('选择模型 {0}', name));
    row.classList.toggle('selected', checkbox.checked);

    const open = node('button', 'model-open');
    open.type = 'button';
    open.setAttribute('aria-label', t('设置模型 {0}', name));
    open.append(node('span', 'model-label', name));
    const preset = routing.lookupPreset(state.database, model.id);
    open.title = `${name}\n${model.id}\n${routing.validDate(preset.releaseDate) ? t('发布日期：{0}', preset.releaseDate) : t('发布日期未知')}`;

    const actions = node('span', 'model-actions');
    actions.append(
      iconButton('edit', t('编辑模型 {0}', name), 'edit-model'),
      iconButton('trash', t('移除模型 {0}', name), 'remove-model')
    );
    row.append(checkbox, open, actions);
    return row;
  }

  function syncSelections() {
    const draft = currentDraft();
    if (!draft) return;
    const split = draft.group.routingMode === 'split';
    const norm = routing.normalizeRouting(draft.group);
    const lists = split ? routing.protocolLists(draft.group) : [];
    const totalSelected = draft.group.models.filter(m => draft.selectedModels.has(m.id)).length;

    $('delete-selected-models').hidden = !totalSelected;
    unavailable($('delete-selected-models'), !totalSelected);

    const unifiedSelectAll = $('select-all-unified');
    unifiedSelectAll.checked = !split && totalSelected > 0 && totalSelected === draft.group.models.length;
    unifiedSelectAll.indeterminate = !split && totalSelected > 0 && totalSelected < draft.group.models.length;
    unavailable(unifiedSelectAll, split || !draft.group.models.length);

    for (const { apiType, models } of lists) {
      const count = models.filter(m => draft.selectedModels.has(m.id)).length;
      const selectAll = $(`select-all-${apiType}`);
      selectAll.checked = models.length > 0 && count === models.length;
      selectAll.indeterminate = count > 0 && count < models.length;
      unavailable(selectAll, !models.length);

      const incoming = draft.group.models.filter(
        m => draft.selectedModels.has(m.id) && routing.routeForModel(draft.group, m.id, norm).apiType !== apiType
      ).length;
      const target = $(`move-to-${apiType}`);
      target.hidden = !totalSelected;
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

  function modelScrollers() {
    return [
      ['list', $('model-list')],
      ...[...$('model-list').querySelectorAll('.model-scroll, .protocol-models')]
        .map(element => [element.closest('[data-protocol]')?.dataset.protocol || 'unified', element])
    ];
  }

  function rememberModelScroll() {
    const draft = drafts.get(renderedGroupId);
    if (!draft) return;
    for (const [key, element] of modelScrollers()) draft.scroll[key] = element.scrollTop;
  }

  function renderModels() {
    rememberModelScroll();
    const draft = currentDraft();
    if (!draft) return;
    const content = document.createDocumentFragment();

    const split = draft.group.routingMode === 'split';
    $('unified-model-selection').hidden = split;
    $('model-list').classList.toggle('split-models', split);
    const total = draft.group.models.length;
    $('model-total').textContent = `${total}`;
    $('model-total').setAttribute('aria-label', t('共 {0} 个模型', total));

    if (split) {
      for (const { apiType, models } of routing.protocolLists(draft.group)) {
        const card = node('section', 'protocol-card');
        card.id = `protocol-card-${apiType}`;
        card.dataset.protocol = apiType;
        card.setAttribute('aria-labelledby', `protocol-heading-${apiType}`);

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
        input.value = draft.group.endpoints[apiType];
        input.setAttribute('aria-label', `${PROTOCOL_NAMES[apiType]} Base URL`);
        endpoint.append(label, input);

        const controls = node('div', 'protocol-controls');
        controls.append(header, endpoint, move);

        const list = node('div', 'protocol-models');
        for (const model of models) list.append(modelRow(model));
        if (!models.length) list.append(node('p', 'empty-models', t('暂无模型')));

        card.append(controls, list);
        content.append(card);
      }
    } else {
      const scroller = node('div', 'model-scroll');
      scroller.id = 'model-scroll';
      for (const model of draft.group.models) scroller.append(modelRow(model));
      if (!draft.group.models.length) scroller.append(node('p', 'empty-models', t('暂无模型')));
      content.append(scroller);
    }
    $('model-list').replaceChildren(content);
    renderedGroupId = draft.group.id;
    for (const [key, element] of modelScrollers()) element.scrollTop = draft.scroll[key] || 0;
    syncSelections();
  }

  function renderRouting() {
    const group = currentDraft().group;
    const split = group.routingMode === 'split';
    $('routing-unified').checked = !split;
    $('routing-split').checked = split;
    $('unified-endpoint').hidden = split;
    $('unified-api-type').value = group.unified.apiType;
    $('unified-url').value = group.unified.url;
  }

  function renderMain(syncFields = true) {
    dirtyStates.clear();
    renderSidebar();
    renderGroups();
    const draft = currentDraft();
    $('group-panel').parentElement.hidden = !draft;
    $('group-panel').hidden = !draft;
    $('empty-provider').hidden = Boolean(draft);
    $('group-list').parentElement.hidden = !draft;
    if (draft) {
      const group = draft.group;
      if (syncFields) {
        $('provider-name').value = draft.provider.name;
        $('group-name').value = group.name;
        $('api-key').value = draft.apiKey;
        clearValidation('group-form');
        message('group-error');
      }
      renderRouting();
      renderModels();
    } else {
      $('api-key').value = '';
    }
    renderStatus();
    syncControls();
  }

  function changed(updateProviders = false) {
    dirtyStates.clear();
    message('group-error');
    clearValidation('group-form');
    if (updateProviders) renderSidebar();
    syncDraftNavigation();
    renderStatus();
    syncControls();
  }

  function clearValidation(formId) {
    for (const field of $(formId).elements) field.removeAttribute('aria-invalid');
  }

  function formError(target, text, fieldId) {
    message(target, text);
    if (fieldId) {
      if (fieldId === 'provider-name' && !providerEdit) beginProviderRename();
      const field = $(fieldId);
      field.setAttribute('aria-invalid', 'true');
      field.focus();
    }
  }

  function validId(id) {
    return typeof id === 'string' && Boolean(id) && id.length <= 512 && !/[\s\u0000-\u001f\u007f]/.test(id) && !['__proto__', 'prototype', 'constructor'].includes(id);
  }
  function validEffort(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(value);
  }
  function effortError(values) {
    if (!Array.isArray(values) || values.length > 32 || values.some(v => !validEffort(v))) {
      return t('最多支持 32 个推理档位，每项为 1–40 个英文字母、数字、连字符或下划线。');
    }
    return null;
  }
  function tokenError(parameters, modelId, apiType) {
    if (!Number.isSafeInteger(parameters.contextWindow) || !Number.isSafeInteger(parameters.maxOutputTokens)
      || parameters.contextWindow <= 0 || parameters.maxOutputTokens <= 0
      || parameters.contextWindow > 100000000 || parameters.maxOutputTokens > 100000000) {
      return t('Context 和 Output 必须是 1–100000000 的整数。');
    }
    if (parameters.maxOutputTokens >= parameters.contextWindow) {
      return t('Output 必须小于 Context。');
    }
    if (parameters.thinking && apiType === 'messages') {
      const preset = routing.lookupPreset(state.database, modelId);
      const profile = preset.protocols?.messages;
      if (!profile?.adaptiveThinking && profile?.thinkingBudget && parameters.maxOutputTokens <= profile.thinkingBudget.min) {
        return t('Output 必须大于该模型的最小思考预算（{0}）。', profile.thinkingBudget.min);
      }
    }
    return null;
  }

  function urlError(value) {
    if (value.length > 4096) return t('API Base URL 不能超过 4096 个字符。');
    try {
      const url = new URL(value.trim());
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
        return t('请填写 http(s) 基础地址，不包含账号、查询参数或片段。');
      }
    } catch {
      return t('请填写有效的 API Base URL。');
    }
    return null;
  }

  function providerNameProblem(provider) {
    if (!provider.name.trim() || provider.name.length > 200) {
      return { text: t('请填写供应商名称，最多 200 个字符。'), field: 'provider-name' };
    }
    if (state.providers.some(item => item.id !== provider.id && item.name.trim() === provider.name.trim())
      || [...drafts.values()].some(item => item.provider.id !== provider.id && item.provider.name.trim() === provider.name.trim())) {
      return { text: t('供应商名称“{0}”已被使用，请修改后重试。', provider.name.trim()), field: 'provider-name' };
    }
    return null;
  }

  function submissionProblem(submission, discovery = false) {
    const nameProblem = providerNameProblem({ id: submission.providerId, name: submission.providerName });
    if (nameProblem) return nameProblem;
    if (submission.groupName.length > 100) {
      return { text: t('分组名称不能超过 100 个字符。'), field: 'group-name' };
    }
    const savedProvider = state.providers.find(item => item.id === submission.providerId);
    const siblings = [...drafts.values()].filter(draft => draft.group.id !== submission.id && draft.provider.id === submission.providerId);
    if (siblings.some(draft => draft.group.name.trim() === submission.groupName.trim())
      || savedProvider?.groups.some(group => group.id !== submission.id && group.name === submission.groupName.trim())) {
      return { text: t('同一供应商内不能重复分组名称“{0}”。', submission.groupName.trim() || t('默认分组')), field: 'group-name' };
    }
    const savedGroup = savedProvider?.groups.find(group => group.id === submission.id);
    const providerRenamed = savedProvider && savedProvider.name !== submission.providerName.trim();
    const names = new Map([[submission.id, savedGroup && !providerRenamed && savedGroup.name === submission.groupName.trim()
      ? savedGroup.officialName : routing.officialGroupName(submission.providerName, submission.groupName)]]);
    if (providerRenamed) {
      for (const group of savedProvider.groups) {
        if (group.id !== submission.id) names.set(group.id, routing.officialGroupName(submission.providerName, group.name));
      }
    }
    const existingNames = new Set(state.providers.flatMap(item => item.groups)
      .filter(group => !names.has(group.id)).map(group => group.officialName));
    for (const nativeName of names.values()) {
      if (existingNames.has(nativeName)) {
        return { text: t('官方配置已有同名分组“{0}”，请修改名称后重试。', nativeName), field: providerRenamed ? 'provider-name' : 'group-name' };
      }
      existingNames.add(nativeName);
    }
    const norm = routing.normalizeRouting(submission);
    const split = submission.routingMode === 'split';
    const routes = split
      ? API_TYPES.map(apiType => ({ apiType, url: submission.endpoints[apiType], field: ENDPOINT_FIELDS[apiType] }))
      : [{ ...submission.unified, field: 'unified-url' }];

    for (const route of routes) {
      const invalidUrl = route.url.trim() ? urlError(route.url) : null;
      if (invalidUrl) return { text: `${PROTOCOL_NAMES[route.apiType]}：${invalidUrl}`, field: route.field };
    }
    if (discovery) {
      return routes.some(r => r.url.trim())
        ? null
        : { text: split ? t('请至少填写一个协议的基础 URL，再刷新模型。') : t('请填写统一协议的基础 URL，再刷新模型。'), field: routes[0].field };
    }
    for (const model of submission.models) {
      const route = routing.routeForModel(submission, model.id, norm);
      if (!route.url.trim()) {
        return {
          text: t('{0} 使用 {1}，请填写对应的基础 URL。', modelLabel(model), PROTOCOL_NAMES[route.apiType]),
          field: split ? ENDPOINT_FIELDS[route.apiType] : 'unified-url'
        };
      }
    }
    if (submission.models.length > 5000) return { text: t('每个分组最多支持 5000 个模型。') };

    const ids = new Set();
    for (const model of submission.models) {
      if (!validId(model.id) || ids.has(model.id)) {
        return { text: t('模型请求 ID 无效或重复，请打开模型设置检查。'), field: 'add-model' };
      }
      ids.add(model.id);
      const route = routing.routeForModel(submission, model.id, norm);
      const base = routing.baseParametersForProtocol(state.database, model.id, route.apiType);
      const parameters = { ...base, ...model.overrides };
      const invalidTokens = tokenError(parameters, model.id, route.apiType);
      if (invalidTokens) return { text: `${modelLabel(model)}：${invalidTokens}` };
      const invalidEfforts = effortError(parameters.supportsReasoningEffort);
      if (invalidEfforts) return { text: `${modelLabel(model)}：${invalidEfforts}` };
      if (model.name.length > 200) return { text: t('模型显示名称不能超过 200 个字符。') };
    }
    return null;
  }

  function prepareGroupSubmission(draft) {
    const submission = {
      ...sanitizeGroup(draft.group),
      providerId: draft.provider.id,
      providerName: draft.provider.name,
      groupName: draft.group.name.trim()
    };
    submission.name = submission.name.trim();
    submission.unified.url = submission.unified.url.trim();
    for (const apiType of API_TYPES) submission.endpoints[apiType] = submission.endpoints[apiType].trim();
    const norm = routing.normalizeRouting(submission);
    for (const model of submission.models) {
      const route = routing.routeForModel(submission, model.id, norm);
      const base = routing.baseParametersForProtocol(state.database, model.id, route.apiType);
      const parameters = { ...base, ...model.overrides };
      if (model.reasoningEffort && (!parameters.thinking || !parameters.supportsReasoningEffort.includes(model.reasoningEffort))) {
        delete model.reasoningEffort;
      }
    }
    delete submission.officialName;
    return submission;
  }

  function showDialog(id, focusId) {
    const dialog = $(id);
    dialogFocus.set(dialog, document.activeElement);
    dialog.showModal();
    if (focusId) $(focusId).focus();
  }

  function confirmAction(label, question, action, detail = '') {
    if (busy) return;
    $('confirm-title').textContent = question;
    $('confirm-action').textContent = label;
    $('confirm-detail').textContent = detail;
    $('confirm-detail').hidden = !detail;
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
      const openDialogs = [...document.querySelectorAll('dialog[open]')];
      if ($('toast').parentElement === dialog) (openDialogs.at(-1) || document.body).append($('toast'));
      const previous = dialogFocus.get(dialog);
      const top = openDialogs.at(-1);
      if (previous?.isConnected && !previous.disabled && (!top || top.contains(previous))) previous.focus();
      else if (top) top.querySelector('input:not(:disabled), button:not(:disabled), select:not(:disabled)')?.focus();
      else if (dialog.id !== 'confirm-dialog') (currentDraft() ? $('group-name') : $('add-provider')).focus();
    });
  }
  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => { if (!busy) $(button.dataset.close).close(); });
  }
  document.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!event.repeat && !busy && !document.querySelector('dialog[open]') && !$('save-group').disabled) {
        void saveGroup(activeId);
      }
      return;
    }
    if (event.key !== 'Escape') return;
    const top = [...document.querySelectorAll('dialog[open]')].at(-1);
    if (!top) return;
    event.preventDefault();
    if (!busy) top.close();
  });
  $('confirm-action').addEventListener('click', () => {
    const action = pendingConfirm;
    pendingConfirm = null;
    $('confirm-dialog').close();
    if (action) action();
  });

  function setProviderName(id, name) {
    for (const draft of drafts.values()) {
      if (draft.provider.id === id) draft.provider.name = name;
    }
  }

  function beginProviderRename() {
    const draft = currentDraft();
    if (!draft || busy) return;
    providerEdit = { id: draft.provider.id, originalName: draft.provider.name };
    renderSidebar();
    $('provider-name').value = draft.provider.name;
    syncControls();
    $('provider-name').focus();
    $('provider-name').select();
  }

  function finishProviderRename(cancel = false) {
    const draft = currentDraft();
    if (!providerEdit || !draft || busy) return;
    if (!cancel) {
      const problem = providerNameProblem(draft.provider);
      if (problem) { formError('group-error', problem.text, problem.field); return; }
    }
    setProviderName(providerEdit.id, cancel ? providerEdit.originalName : draft.provider.name.trim());
    providerEdit = null;
    changed(true);
    $('provider-list').querySelector('[aria-current="page"]')?.focus();
  }

  function confirmProviderDeletion() {
    const draft = currentDraft();
    if (!draft || busy) return;
    settleProviderRename(true);
    const id = draft.provider.id;
    const groupIds = new Set(state.providers.find(provider => provider.id === id)?.groups.map(group => group.id));
    for (const item of drafts.values()) {
      if (item.provider.id === id) groupIds.add(item.group.id);
    }
    confirmAction(t('删除供应商'), t('确认删除供应商“{0}”？', draft.provider.name.trim() || t('新供应商')),
      () => deleteProvider(id), t('将删除全部 {0} 个分组及其模型、API Key。', groupIds.size));
  }

  async function deleteProvider(id) {
    await runAction(t('正在删除供应商…'), async () => {
      const next = state.providers.some(provider => provider.id === id)
        ? await request('deleteProvider', { id }) : state;
      applyState(next, { deletedProviderId: id });
      showToast(t('已删除'), false);
    }, 'group-error');
  }

  function addProvider() {
    if (!state || busy) return;
    settleProviderRename();
    const provider = { id: `provider-${crypto.randomUUID()}`, name: uniqueProviderName() };
    const group = { id: `group-${crypto.randomUUID()}`, name: '', ...routing.normalizeRouting({}), models: [] };
    drafts.set(group.id, makeDraft(provider, group, false));
    switchGroup(group.id);
    renderMain();
    beginProviderRename();
  }

  function addGroup() {
    const draft = currentDraft();
    if (!draft || busy) return;
    settleProviderRename();
    const group = {
      ...sanitizeGroup(draft.group),
      id: `group-${crypto.randomUUID()}`,
      name: uniqueGroupName(draft.provider.id),
      models: [], modelProtocols: {}, officialName: ''
    };
    drafts.set(group.id, makeDraft(draft.provider, group, false));
    switchGroup(group.id);
    renderMain();
    $('group-name').focus();
    $('group-name').select();
  }

  async function saveGroup(id, confirmed = false) {
    const draft = drafts.get(id);
    if (!draft || busy || !isDirty(draft)) return;
    const prepared = prepareGroupSubmission(draft);
    const problem = submissionProblem(prepared);
    if (problem) { formError('group-error', problem.text, problem.field); return; }
    if (draft.apiKey.length > 16000) { formError('group-error', t('API Key 不能超过 16000 个字符。'), 'api-key'); return; }
    const provider = { id: prepared.providerId, name: prepared.providerName.trim() };
    const { providerId: _providerId, providerName: _providerName, groupName: _groupName, ...group } = prepared;
    const savedProvider = state.providers.find(item => item.id === provider.id);
    const renamed = (savedProvider && provider.name !== savedProvider.name)
      || (draft.baseline && group.name !== draft.baseline.name);
    if (renamed && !confirmed) {
      confirmAction(t('继续保存'), t('确认修改名称？'), () => saveGroup(id, true),
        t('VS Code 会将重命名后的模型视为新模型。当前模型选择、隐藏和固定状态需要重新设置。'));
      return;
    }
    await runAction(t('正在保存分组…'), async () => {
      const payload = { provider, group };
      if (draft.apiKey.trim()) payload.apiKey = draft.apiKey.trim();
      const next = await request('saveGroup', payload);
      applyState(next, { savedIds: [id], savedProviderId: provider.id, focusId: id });
      $('api-key').value = '';
      showToast(t('已保存'), false);
    }, 'group-error', 'save-group');
  }

  async function deleteGroup(id) {
    const draft = drafts.get(id);
    if (!draft) return;
    if (!draft.baseline) {
      draft.apiKey = '';
      drafts.delete(id);
      const next = [...drafts].find(([, item]) => item.provider.id === draft.provider.id)?.[0]
        || drafts.keys().next().value || null;
      activeId = next;
      renderMain();
      showToast(t('已移除未保存的分组'), false);
      return;
    }
    await runAction(t('正在删除分组…'), async () => {
      const next = await request('deleteGroup', { id });
      applyState(next, { deletedId: id });
      showToast(t('已删除'), false);
    }, 'group-error');
  }

  async function discoverModels() {
    const draft = currentDraft();
    if (!draft || busy) return;
    const submission = prepareGroupSubmission(draft);
    const problem = submissionProblem(submission, true);
    if (problem) { formError('group-error', problem.text, problem.field); return; }
    if (draft.apiKey.length > 16000) { formError('group-error', t('API Key 不能超过 16000 个字符。'), 'api-key'); return; }
    $('model-list').setAttribute('aria-busy', 'true');
    await runAction(t('正在刷新模型…'), async () => {
      const { providerId: _providerId, providerName: _providerName, groupName: _groupName, ...group } = prepareGroupSubmission(draft);
      const payload = { group };
      if (draft.apiKey.trim()) payload.apiKey = draft.apiKey.trim();
      const result = await request('discoverModels', payload);
      if (!result || !Array.isArray(result.models)) throw new Error(t('扩展返回的模型列表格式无效。'));
      if (result.database?.models) {
        state.database = result.database;
      }
      const target = drafts.get(group.id);
      if (!target) return;
      const models = routing.replaceModels(target.group.models, result.models);
      if (models.length > 5000) throw new Error(t('每个分组最多支持 5000 个模型。'));
      target.group.models = models;
      target.group.modelProtocols = routing.normalizeRouting({ ...target.group, models, modelProtocols: {} }).modelProtocols;
      target.selectedModels.clear();
      renderMain(false);
    }, 'group-error', 'refresh-models');
    $('model-list').setAttribute('aria-busy', 'false');
    renderStatus();
  }

  $('add-provider').addEventListener('click', addProvider);
  $('empty-add').addEventListener('click', addProvider);
  $('add-group').addEventListener('click', addGroup);
  $('provider-list').addEventListener('click', event => {
    const action = event.target.closest('[data-provider-action]');
    if (action) {
      if (busy) return;
      if (action.dataset.providerAction === 'rename') beginProviderRename();
      else if (action.dataset.providerAction === 'finish') finishProviderRename();
      else if (action.dataset.providerAction === 'cancel') finishProviderRename(true);
      else if (action.dataset.providerAction === 'delete') confirmProviderDeletion();
      return;
    }
    const button = event.target.closest('[data-provider-id]');
    if (!button || busy) return;
    const providerId = button.dataset.providerId;
    const remembered = drafts.get(activeGroups.get(providerId));
    const target = remembered?.provider.id === providerId ? remembered
      : [...drafts.values()].find(draft => draft.provider.id === providerId);
    if (!target || target.group.id === activeId) return;
    switchGroup(target.group.id);
    renderMain();
    $('provider-list').querySelector('[aria-current="page"]')?.focus();
  });
  $('provider-list').addEventListener('dblclick', event => {
    const button = event.target.closest('[data-provider-id]');
    if (button && !busy && button.dataset.providerId === currentDraft()?.provider.id) beginProviderRename();
  });
  $('group-list').addEventListener('click', event => {
    const button = event.target.closest('[data-group-id]');
    if (!button || busy || button.dataset.groupId === activeId) return;
    switchGroup(button.dataset.groupId);
    renderMain();
    $('group-list').querySelector('[aria-current="page"]')?.focus();
  });

  for (const [id, selector] of [['provider-list', '[data-provider-id]'], ['group-list', '[data-group-id]']]) {
    $(id).addEventListener('keydown', event => {
      if (busy || event.altKey || event.ctrlKey || event.metaKey || !event.target.matches(selector)) return;
      const horizontal = id === 'provider-list' || matchMedia('(max-width: 760px)').matches;
      const previous = horizontal ? 'ArrowLeft' : 'ArrowUp';
      const next = horizontal ? 'ArrowRight' : 'ArrowDown';
      if (![previous, next, 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...$(id).querySelectorAll(selector)];
      const index = buttons.indexOf(event.target);
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === previous ? -1 : 1) + buttons.length) % buttons.length;
      buttons[target]?.click();
      $(id).querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  $('provider-name').addEventListener('input', event => {
    const draft = currentDraft();
    if (!draft) return;
    setProviderName(draft.provider.id, event.target.value);
    changed(false);
  });
  $('provider-name').addEventListener('keydown', event => {
    if (event.isComposing || !['Enter', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    finishProviderRename(event.key === 'Escape');
  });
  $('group-name').addEventListener('input', event => {
    const draft = currentDraft();
    if (!draft) return;
    draft.group.name = event.target.value;
    changed();
  });

  for (const mode of ['unified', 'split']) {
    $(`routing-${mode}`).addEventListener('change', event => {
      const draft = currentDraft();
      if (!draft || busy || !event.target.checked || draft.group.routingMode === mode) return;
      if (mode === 'split') {
        const baseUrl = draft.group.unified.url.trim();
        if (baseUrl) {
          for (const apiType of API_TYPES) {
            if (!draft.group.endpoints[apiType].trim()) draft.group.endpoints[apiType] = baseUrl;
          }
        }
      } else if (!draft.group.unified.url.trim()) {
        const preferred = draft.group.endpoints[draft.group.unified.apiType]?.trim()
          || API_TYPES.map(api => draft.group.endpoints[api]?.trim()).find(Boolean)
          || '';
        if (preferred) draft.group.unified.url = preferred;
      }
      draft.group.routingMode = mode;
      draft.selectedModels.clear();
      renderRouting();
      renderModels();
      changed();
    });
  }

  $('unified-api-type').addEventListener('change', event => {
    const draft = currentDraft();
    if (!draft || busy || !API_TYPES.includes(event.target.value)) return;
    draft.group.unified.apiType = event.target.value;
    renderModels();
    changed();
  });

  function unifiedUrlChanged(event) {
    const draft = currentDraft();
    if (!draft || busy) return;
    draft.group.unified.url = event.target.value;
    changed();
  }
  $('unified-url').addEventListener('input', unifiedUrlChanged);
  $('unified-url').addEventListener('change', unifiedUrlChanged);

  function endpointChanged(event) {
    const input = event.target.closest('[data-endpoint]');
    const draft = currentDraft();
    if (!input || !draft || busy || !API_TYPES.includes(input.dataset.endpoint)) return;
    draft.group.endpoints[input.dataset.endpoint] = input.value;
    changed();
  }
  $('model-list').addEventListener('input', endpointChanged);
  $('api-key').addEventListener('input', event => {
    const draft = currentDraft();
    if (!draft) return;
    draft.apiKey = event.target.value;
    changed();
  });

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
      const models = selectAll.dataset.selectAll === 'unified'
        ? draft.group.models
        : routing.protocolLists(draft.group).find(list => list.apiType === selectAll.dataset.selectAll)?.models || [];
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

  $('delete-selected-models').addEventListener('click', () => {
    const draft = currentDraft();
    if (!draft || busy) return;
    const ids = new Set(draft.group.models.filter(m => draft.selectedModels.has(m.id)).map(m => m.id));
    if (!ids.size) return;
    confirmAction(t('删除'), t('确认删除？'), () => {
      if (currentDraft() !== draft) return;
      draft.group.models = draft.group.models.filter(m => !ids.has(m.id));
      for (const id of ids) delete draft.group.modelProtocols[id];
      draft.selectedModels.clear();
      renderModels();
      changed();
    });
  });

  $('group-form').addEventListener('submit', event => {
    event.preventDefault();
    const draft = currentDraft();
    if (!draft || busy) return;
    void saveGroup(draft.group.id);
  });

  $('delete-group').addEventListener('click', () => {
    const draft = currentDraft();
    if (!draft) return;
    const id = draft.group.id;
    confirmAction(t('删除'), t('确认删除分组“{0}”？', groupName(draft)), () => deleteGroup(id),
      draft.baseline ? t('将同时删除此分组的模型和已保存的 API Key。此操作无法撤销。') : '');
  });

  $('refresh-models').addEventListener('click', () => { void discoverModels(); });

  function currentDialogProtocol() {
    const draft = drafts.get(modelSession.groupId);
    if (draft.group.routingMode === 'unified') return draft.group.unified.apiType;
    return $('model-protocol').value || routing.recommendedProtocol($('model-id').value.trim());
  }

  function renderEfforts(values) {
    const content = document.createDocumentFragment();
    for (const value of new Set([...EFFORTS, ...(values || [])])) {
      const label = node('label', 'checkbox');
      const input = node('input');
      input.type = 'checkbox';
      input.value = value;
      input.checked = (values || []).includes(value);
      label.append(input, document.createTextNode(value));
      content.append(label);
    }
    $('effort-options').replaceChildren(content);
  }

  function readEfforts() {
    return [...$('effort-options').querySelectorAll('input:checked')].map(input => input.value);
  }

  function syncReasoning(selected = $('reasoning-effort').value) {
    const thinking = $('cap-thinking').checked;
    unavailable($('effort-fieldset'), !thinking);
    for (const input of $('effort-options').querySelectorAll('input')) {
      unavailable(input, !thinking);
    }

    const values = readEfforts().filter(validEffort);
    const content = document.createDocumentFragment();
    const automatic = node('option', '', t('默认（不指定）'));
    automatic.value = '';
    content.append(automatic);
    for (const value of values) {
      const option = node('option', '', value);
      option.value = value;
      content.append(option);
    }
    $('reasoning-effort').replaceChildren(content);
    $('reasoning-effort').value = thinking && values.includes(selected) ? selected : '';
    unavailable($('reasoning-effort'), !thinking || !values.length);
  }

  function fillModelParameters(parameters, selectedEffort = '') {
    $('context-window').value = parameters.contextWindow;
    $('max-output').value = parameters.maxOutputTokens;
    $('cap-tools').checked = parameters.toolCalling;
    $('cap-vision').checked = parameters.vision;
    $('cap-thinking').checked = parameters.thinking;
    renderEfforts(parameters.supportsReasoningEffort);
    syncReasoning(selectedEffort);
    syncControls();
  }

  function openModel(id = null) {
    const draft = currentDraft();
    if (!draft || busy) return;
    settleProviderRename(true);
    const model = id ? draft.group.models.find(item => item.id === id) : { id: '', name: '', overrides: {} };
    if (!model) return;
    ensureModelDatalist();

    const initialProtocol = id && own(draft.group.modelProtocols, id)
      ? draft.group.modelProtocols[id]
      : routing.recommendedProtocol(model.id);
    const defaultName = model.id ? routing.displayModelName(state.database, { id: model.id, name: '' }) : '';

    modelSession = {
      groupId: draft.group.id,
      original: clone(model),
      editingId: id,
      requestId: model.id,
      automaticName: model.name ? null : defaultName,
      protocolTouched: Boolean(id && own(draft.group.modelProtocols, id)),
      effortsTouched: own(model.overrides || {}, 'supportsReasoningEffort')
    };

    $('model-title').textContent = id ? t('模型设置') : t('添加模型');
    $('apply-model').textContent = id ? t('确定') : t('添加');
    $('model-id').value = model.id;
    $('model-name').value = model.id ? modelLabel(model) : '';
    $('model-protocol').value = initialProtocol;
    $('model-protocol-field').hidden = draft.group.routingMode === 'unified';
    unavailable($('model-protocol'), draft.group.routingMode === 'unified');

    clearValidation('model-form');
    message('model-error');

    const apiType = currentDialogProtocol();
    const base = routing.baseParametersForProtocol(state.database, model.id, apiType);
    fillModelParameters({ ...base, ...model.overrides }, model.reasoningEffort || '');
    showDialog('model-dialog', id ? 'model-name' : 'model-id');
  }

  function changeModelId() {
    if (!modelSession) return;
    const id = $('model-id').value.trim();
    if (id === modelSession.requestId) return;
    modelSession.requestId = id;
    const original = modelSession.original;

    const isAutoName = !$('model-name').value.trim() || $('model-name').value === modelSession.automaticName;
    if (isAutoName) {
      const name = id ? routing.displayModelName(state.database, { id, name: '' }) : '';
      $('model-name').value = name;
      modelSession.automaticName = name;
    }
    if (!modelSession.protocolTouched) {
      $('model-protocol').value = routing.recommendedProtocol(id);
    }
    modelSession.effortsTouched = id === original.id && own(original.overrides || {}, 'supportsReasoningEffort');
    const apiType = currentDialogProtocol();
    const base = routing.baseParametersForProtocol(state.database, id, apiType);
    const parameters = { ...base, ...(id === original.id ? original.overrides : {}) };
    fillModelParameters(parameters, id === original.id ? (original.reasoningEffort || '') : '');
    message('model-error');
    clearValidation('model-form');
  }

  $('add-model').addEventListener('click', () => openModel());
  $('model-list').addEventListener('click', event => {
    const draft = currentDraft();
    if (!draft || busy) return;
    const move = event.target.closest('[data-move-to]');
    if (move && draft.group.routingMode === 'split') {
      const target = move.dataset.moveTo;
      if (!API_TYPES.includes(target)) return;
      const protocols = routing.normalizeRouting(draft.group).modelProtocols;
      const ids = draft.group.models
        .filter(m => draft.selectedModels.has(m.id) && protocols[m.id] !== target)
        .map(m => m.id);
      if (!ids.length) return;
      draft.group.modelProtocols = routing.assignModels(draft.group, ids, target);
      renderModels();
      changed();
      const firstMoved = [...$('model-list').querySelectorAll('[data-select-model]')].find(cb => cb.dataset.selectModel === ids[0]);
      firstMoved?.focus();
      return;
    }
    const row = event.target.closest('[data-model-id]');
    if (!row) return;
    const model = draft.group.models.find(item => item.id === row.dataset.modelId);
    if (!model) return;
    if (event.target.closest('.remove-model')) {
      draft.group.models = draft.group.models.filter(item => item.id !== model.id);
      delete draft.group.modelProtocols[model.id];
      draft.selectedModels.delete(model.id);
      renderModels();
      changed();
      $('add-model').focus();
    } else if (event.target.closest('.model-open, .edit-model')) {
      openModel(model.id);
    }
  });

  $('model-id').addEventListener('input', changeModelId);
  $('model-id').addEventListener('change', changeModelId);
  $('model-protocol').addEventListener('change', () => {
    if (!modelSession || busy) return;
    modelSession.protocolTouched = true;
    if (!modelSession.effortsTouched) {
      const id = $('model-id').value.trim();
      const base = routing.baseParametersForProtocol(state.database, id, currentDialogProtocol());
      renderEfforts(base.supportsReasoningEffort);
    }
    syncReasoning();
    syncControls();
  });
  $('effort-options').addEventListener('change', () => {
    if (modelSession) modelSession.effortsTouched = true;
    syncReasoning();
  });
  $('cap-thinking').addEventListener('change', () => {
    syncReasoning();
    syncControls();
  });

  $('model-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!modelSession || busy) return;
    clearValidation('model-form');
    const draft = drafts.get(modelSession.groupId);
    if (!draft) return;

    const id = $('model-id').value.trim();
    const name = $('model-name').value.trim();
    const isAutoName = name === modelSession.automaticName;
    if (!name || (!isAutoName && name.length > 200)) {
      formError('model-error', t('请填写显示名称，最多 200 个字符。'), 'model-name');
      return;
    }
    if (!validId(id)) {
      formError('model-error', t('请填写有效的请求模型 ID，最多 512 个字符，不能包含空白字符。'), 'model-id');
      return;
    }
    if (routing.isExcludedModel(id)) {
      formError('model-error', t('此模型不支持聊天，请填写聊天模型的请求 ID。'), 'model-id');
      return;
    }
    if (!modelSession.editingId && draft.group.models.length >= 5000) {
      formError('model-error', t('每个分组最多支持 5000 个模型。'));
      return;
    }
    if (draft.group.models.some(m => m.id === id && m.id !== modelSession.editingId)) {
      formError('model-error', t('此请求模型 ID 已添加，请直接编辑现有模型。'), 'model-id');
      return;
    }

    const splitApiType = draft.group.routingMode === 'split'
      ? $('model-protocol').value
      : (modelSession.editingId && draft.group.modelProtocols[modelSession.editingId]) || routing.recommendedProtocol(id);
    if (!API_TYPES.includes(splitApiType)) {
      formError('model-error', t('请选择有效的请求协议。'), 'model-protocol');
      return;
    }
    const effectiveApiType = draft.group.routingMode === 'unified' ? draft.group.unified.apiType : splitApiType;
    const base = routing.baseParametersForProtocol(state.database, id, effectiveApiType);

    const thinking = $('cap-thinking').checked;
    const supportsReasoningEffort = thinking || modelSession.effortsTouched ? readEfforts() : base.supportsReasoningEffort;
    const parameters = {
      contextWindow: Number($('context-window').value),
      maxOutputTokens: Number($('max-output').value),
      toolCalling: $('cap-tools').checked,
      vision: $('cap-vision').checked,
      thinking,
      supportsReasoningEffort
    };

    const problem = tokenError(parameters, id, effectiveApiType);
    if (problem) { formError('model-error', problem, 'max-output'); return; }
    const invalidEfforts = effortError(parameters.supportsReasoningEffort);
    if (invalidEfforts) { formError('model-error', invalidEfforts); return; }

    const reasoningEffort = $('reasoning-effort').value;
    if (reasoningEffort && (!parameters.thinking || !parameters.supportsReasoningEffort.includes(reasoningEffort))) {
      formError('model-error', t('请选择可用的实际推理档位。'), 'reasoning-effort');
      return;
    }

    const overrides = {};
    for (const field of PARAMETER_FIELDS) {
      if (!equal(parameters[field], base[field])) overrides[field] = parameters[field];
    }

    const nextModel = {
      id,
      name: isAutoName ? '' : name,
      overrides,
      ...(reasoningEffort ? { reasoningEffort } : {})
    };

    const index = draft.group.models.findIndex(m => m.id === modelSession.editingId);
    if (index >= 0) draft.group.models[index] = nextModel;
    else draft.group.models.push(nextModel);

    if (modelSession.editingId && modelSession.editingId !== id) delete draft.group.modelProtocols[modelSession.editingId];
    draft.group.modelProtocols[id] = splitApiType;
    draft.group.modelProtocols = routing.normalizeRouting(draft.group).modelProtocols;
    if (draft.selectedModels.delete(modelSession.editingId)) draft.selectedModels.add(id);

    $('model-dialog').close();
    changed();
    renderModels();
    syncControls();
  });

  function updateTransferSelection() {
    const { mode, providers, selected } = transferSession;
    const count = selected.size;
    const total = providers.length;
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
      meta.append(node('span', '', t('{0} 个分组', provider.groups.length)));
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
    settleProviderRename(true);
    const providers = mode === 'export' ? state.providers : [];
    transferSession = { mode, providers, selected: new Set(providers.map(p => p.id)) };
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
      showToast(target === 'clipboard' ? t('已复制') : t('已导出'), false);
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
      transferSession.selected = new Set(result.providers.map(p => p.id));
      renderTransferDialog();
    }, 'import-error');
  }

  async function applyImport() {
    if (transferSession?.mode !== 'import' || busy) return;
    const chosen = transferSession.providers.filter(p => transferSession.selected.has(p.id));
    if (!chosen.length) return;
    await runAction(t('正在导入供应商…'), async () => {
      const result = await request('importProviders', { providers: chosen });
      const targetId = result.importedIds?.[0];
      const first = result.state.providers.find(provider => provider.id === targetId)?.groups[0]?.id;
      applyState(result.state, { focusId: first || activeId });
      $('import-dialog').close();
      showToast(t('已导入'), false);
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

  async function loadState() {
    const loaded = await runAction(t('正在加载配置…'), async () => {
      const next = await request('getState');
      applyState(next);
    }, state ? undefined : 'load-error-message');
    if (!loaded && !state) {
      $('loading-state').hidden = true;
      $('load-error').hidden = false;
    }
    syncControls();
  }

  $('retry-state').addEventListener('click', () => { void loadState(); });
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
