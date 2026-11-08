(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ByokModelOrder = api;
})(globalThis, function () {
  'use strict';

  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00.000Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function releaseDate(model, records) {
    const value = Object.prototype.hasOwnProperty.call(records, model.id) ? records[model.id].releaseDate : undefined;
    return validDate(value) ? value : null;
  }

  return { validDate, releaseDate };
});
