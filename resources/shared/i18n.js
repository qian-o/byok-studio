(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./messages.en.js'));
  else root.ByokI18n = factory(root.ByokEnglishMessages);
})(globalThis, function (english) {
  'use strict';
  let locale = 'en';
  function setLocale(language) { locale = /^zh(?:[-_]|$)/i.test(language || '') ? 'zh-CN' : 'en'; }
  function getLocale() { return locale; }
  function t(message, ...values) {
    const translated = locale === 'en' && Object.hasOwn(english, message) ? english[message] : message;
    return translated.replace(/\{(\d+)\}/g, (match, index) => Number(index) < values.length ? String(values[Number(index)]) : match);
  }
  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }
  function renderHtml(template) {
    return template.replace(/\{\{LANGUAGE\}\}/g, locale)
      .replace(/\{\{t:([^}]+)\}\}/g, (_match, message) => escapeHtml(t(message)));
  }
  if (typeof document !== 'undefined') setLocale(document.documentElement.lang);
  return { t, setLocale, getLocale, renderHtml };
});
