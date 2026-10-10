(function (global) {
  "use strict";

  var DEFAULT_ENDPOINT = "http://alpha.tail3327f9.ts.net:8800";
  var STORAGE_KEY = "breadcrumbsEndpoint";

  function getEndpoint() {
    return new Promise(function (resolve) {
      if (!global.chrome || !global.chrome.storage) {
        resolve(DEFAULT_ENDPOINT);
        return;
      }
      global.chrome.storage.local.get([STORAGE_KEY], function (items) {
        resolve((items && items[STORAGE_KEY]) || DEFAULT_ENDPOINT);
      });
    });
  }

  function requestEndpointPermission(endpoint) {
    try {
      var origin = new global.URL(endpoint).origin + "/*";
      if (!global.chrome || !global.chrome.permissions) {
        return Promise.resolve(true);
      }
      return new Promise(function (resolve) {
        global.chrome.permissions.request({ origins: [origin] }, function (granted) {
          resolve(!!granted);
        });
      });
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function setEndpoint(endpoint) {
    return requestEndpointPermission(endpoint).then(function (granted) {
      if (!granted) return false;
      return new Promise(function (resolve) {
        if (!global.chrome || !global.chrome.storage) {
          resolve(true);
          return;
        }
        var payload = {};
        payload[STORAGE_KEY] = endpoint;
        global.chrome.storage.local.set(payload, function () {
          resolve(true);
        });
      });
    });
  }

  global.BreadcrumbsConfig = {
    DEFAULT_ENDPOINT: DEFAULT_ENDPOINT,
    getEndpoint: getEndpoint,
    setEndpoint: setEndpoint,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.BreadcrumbsConfig;
  }
})(typeof self !== "undefined" ? self : globalThis);
