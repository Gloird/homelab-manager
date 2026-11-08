import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { createFreeboxClient } from '../src/freebox.js';

const baseSettings = {
  _id: 'freebox' as const,
  enabled: true,
  url: 'http://mafreebox.freebox.fr',
  appToken: '',
  appId: 'homelab-manager',
  appName: 'Homelab Manager',
  apiVersion: 4,
};

test('Freebox auth check handles status-based granted response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, 'GET');
    assert.match(String(input), /\/login\/authorize\/42$/);
    return new Response(
      JSON.stringify({ success: true, result: { status: 'granted', timeout: 0, challenge: 'abc' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const client = createFreeboxClient(baseSettings);
    const result = await client.checkAuthorization(42);
    assert.equal(result.granted, true);
    assert.equal(result.status, 'granted');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Freebox auth check keeps compatibility with legacy granted boolean', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ success: true, result: { granted: true, timeout: 0, challenge: 'abc', app_token: 'tok' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  try {
    const client = createFreeboxClient(baseSettings);
    const result = await client.checkAuthorization(7);
    assert.equal(result.granted, true);
    assert.equal(result.status, 'granted');
    assert.equal(result.app_token, 'tok');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Freebox api version uses root endpoint format', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, 'GET');
    assert.equal(String(input), 'http://mafreebox.freebox.fr/api_version');
    return new Response(
      JSON.stringify({
        box_model_name: 'Freebox',
        api_base_url: '/api/',
        https_port: 443,
        device_name: 'Freebox Server',
        https_available: true,
        box_model: 'fbxgw',
        api_domain: 'mafreebox.freebox.fr',
        uid: 'uid-1',
        api_version: '4.8',
        device_type: 'FreeboxServer7,1',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const client = createFreeboxClient(baseSettings);
    const result = await client.getApiVersion();
    assert.equal(result.api_version, '4.8');
    assert.equal(result.uid, 'uid-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Freebox auth check retries with discovered api_base_url after invalid request 404', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    assert.equal(init?.method, 'GET');
    if (calls === 1) {
      assert.equal(String(input), 'http://mafreebox.freebox.fr/api/v4/login/authorize/42');
      return new Response(
        JSON.stringify({ success: false, error_code: 'invalid_request', msg: 'Requête invalide (404)' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (calls === 2) {
      assert.equal(String(input), 'http://mafreebox.freebox.fr/api_version');
      return new Response(
        JSON.stringify({
          box_model_name: 'Freebox',
          api_base_url: '/api/v8/',
          https_port: 443,
          device_name: 'Freebox Server',
          https_available: true,
          box_model: 'fbxgw',
          api_domain: 'mafreebox.freebox.fr',
          uid: 'uid-1',
          api_version: '8.0',
          device_type: 'FreeboxServer8,1',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    assert.equal(String(input), 'http://mafreebox.freebox.fr/api/v8/login/authorize/42');
    return new Response(
      JSON.stringify({ success: true, result: { status: 'granted', timeout: 0, challenge: 'ok' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const client = createFreeboxClient(baseSettings);
    const result = await client.checkAuthorization(42);
    assert.equal(result.granted, true);
    assert.equal(result.status, 'granted');
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Freebox auth check retries after unknown api version error', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    assert.equal(init?.method, 'GET');
    if (calls === 1) {
      assert.equal(String(input), 'http://mafreebox.freebox.fr/api/v4/login/authorize/99');
      return new Response(
        JSON.stringify({ success: false, error_code: 'unknown_api_version', msg: "Version d'API inconnue" }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (calls === 2) {
      assert.equal(String(input), 'http://mafreebox.freebox.fr/api_version');
      return new Response(
        JSON.stringify({
          box_model_name: 'Freebox',
          api_base_url: '/api/',
          https_port: 443,
          device_name: 'Freebox Server',
          https_available: true,
          box_model: 'fbxgw',
          api_domain: 'mafreebox.freebox.fr',
          uid: 'uid-1',
          api_version: '8.0',
          device_type: 'FreeboxServer8,1',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (calls === 3) {
      const url = String(input);
      if (url === 'http://mafreebox.freebox.fr/api/v8/login/authorize/99') {
        return new Response(
          JSON.stringify({ success: true, result: { status: 'granted', timeout: 0, challenge: 'ok' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      assert.equal(url, 'http://mafreebox.freebox.fr/api/v8.0/login/authorize/99');
      return new Response(
        JSON.stringify({ success: false, error_code: 'unknown_api_version', msg: "Version d'API inconnue" }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    assert.equal(String(input), 'http://mafreebox.freebox.fr/api/v8/login/authorize/99');
    return new Response(
      JSON.stringify({ success: true, result: { status: 'granted', timeout: 0, challenge: 'ok' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const client = createFreeboxClient(baseSettings);
    const result = await client.checkAuthorization(99);
    assert.equal(result.granted, true);
    assert.equal(result.status, 'granted');
    assert.ok(calls === 3 || calls === 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Freebox auth check handles api_base_url with minor version suffix', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    assert.equal(init?.method, 'GET');
    if (calls === 1) {
      assert.equal(String(input), 'http://mafreebox.freebox.fr/api/v4/login/authorize/77');
      return new Response(
        JSON.stringify({ success: false, error_code: 'unknown_api_version', msg: "Version d'API inconnue" }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (calls === 2) {
      assert.equal(String(input), 'http://mafreebox.freebox.fr/api_version');
      return new Response(
        JSON.stringify({
          box_model_name: 'Freebox',
          api_base_url: '/api/v8.0/',
          https_port: 443,
          device_name: 'Freebox Server',
          https_available: true,
          box_model: 'fbxgw',
          api_domain: 'mafreebox.freebox.fr',
          uid: 'uid-1',
          api_version: '8.0',
          device_type: 'FreeboxServer8,1',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (calls === 3) {
      assert.equal(String(input), 'http://mafreebox.freebox.fr/api/v8.0/login/authorize/77');
      return new Response(
        JSON.stringify({ success: false, error_code: 'unknown_api_version', msg: "Version d'API inconnue" }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    assert.equal(String(input), 'http://mafreebox.freebox.fr/api/v8/login/authorize/77');
    return new Response(
      JSON.stringify({ success: true, result: { status: 'granted', timeout: 0, challenge: 'ok' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const client = createFreeboxClient(baseSettings);
    const result = await client.checkAuthorization(77);
    assert.equal(result.granted, true);
    assert.equal(result.status, 'granted');
    assert.equal(calls, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Freebox auth check retries using full discovered api_version when needed', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    assert.equal(init?.method, 'GET');
    if (calls === 1) {
      assert.equal(String(input), 'http://mafreebox.freebox.fr/api/v4/login/authorize/55');
      return new Response(
        JSON.stringify({ success: false, error_code: 'unknown_api_version', msg: "Version d'API inconnue" }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (calls === 2) {
      assert.equal(String(input), 'http://mafreebox.freebox.fr/api_version');
      return new Response(
        JSON.stringify({
          box_model_name: 'Freebox',
          api_base_url: '/api/',
          https_port: 443,
          device_name: 'Freebox Server',
          https_available: true,
          box_model: 'fbxgw',
          api_domain: 'mafreebox.freebox.fr',
          uid: 'uid-1',
          api_version: '16.1',
          device_type: 'FreeboxServer7,1',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (calls === 3) {
      assert.equal(String(input), 'http://mafreebox.freebox.fr/api/v16.1/login/authorize/55');
      return new Response(
        JSON.stringify({ success: true, result: { status: 'granted', timeout: 0, challenge: 'ok' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected fetch call ${calls}: ${String(input)}`);
  };

  try {
    const client = createFreeboxClient(baseSettings);
    const result = await client.checkAuthorization(55);
    assert.equal(result.granted, true);
    assert.equal(result.status, 'granted');
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Freebox auth check retries on discovered api_domain and https_port', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    assert.equal(init?.method, 'GET');
    if (calls === 1) {
      assert.equal(String(input), 'http://mafreebox.freebox.fr/api/v4/login/authorize/66');
      return new Response(
        JSON.stringify({ success: false, error_code: 'unknown_api_version', msg: "Version d'API inconnue" }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (calls === 2) {
      assert.equal(String(input), 'http://mafreebox.freebox.fr/api_version');
      return new Response(
        JSON.stringify({
          box_model_name: 'Freebox',
          api_base_url: '/api/',
          https_port: 18872,
          device_name: 'Freebox Server',
          https_available: true,
          box_model: 'fbxgw7-r1/full',
          api_domain: 'cpojtnw3.fbxos.fr',
          uid: 'uid-1',
          api_version: '16.1',
          device_type: 'FreeboxServer7,1',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (calls <= 5) {
      return new Response(
        JSON.stringify({ success: false, error_code: 'unknown_api_version', msg: "Version d'API inconnue" }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const successUrl = String(input);
    assert.ok(
      successUrl === 'https://cpojtnw3.fbxos.fr:18872/api/v16/login/authorize/66'
      || successUrl === 'https://cpojtnw3.fbxos.fr:18872/api/v16.1/login/authorize/66'
      || successUrl === 'https://mafreebox.freebox.fr:18872/api/v16/login/authorize/66'
      || successUrl === 'https://mafreebox.freebox.fr:18872/api/v16.1/login/authorize/66',
    );
    return new Response(
      JSON.stringify({ success: true, result: { status: 'granted', timeout: 0, challenge: 'ok' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const client = createFreeboxClient(baseSettings);
    const result = await client.checkAuthorization(66);
    assert.equal(result.granted, true);
    assert.equal(result.status, 'granted');
    assert.ok(calls >= 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Freebox auth check continues fallback attempts after fetch error', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    assert.equal(init?.method, 'GET');
    const url = String(input);
    if (calls === 1) {
      assert.equal(url, 'http://mafreebox.freebox.fr/api/v4/login/authorize/67');
      return new Response(
        JSON.stringify({ success: false, error_code: 'unknown_api_version', msg: "Version d'API inconnue" }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (calls === 2) {
      assert.equal(url, 'http://mafreebox.freebox.fr/api_version');
      return new Response(
        JSON.stringify({
          box_model_name: 'Freebox',
          api_base_url: '/api/',
          https_port: 18872,
          device_name: 'Freebox Server',
          https_available: true,
          box_model: 'fbxgw7-r1/full',
          api_domain: 'cpojtnw3.fbxos.fr',
          uid: 'uid-1',
          api_version: '16.1',
          device_type: 'FreeboxServer7,1',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.startsWith('https://mafreebox.freebox.fr:18872/')) {
      throw new Error('fetch failed');
    }
    if (url.startsWith('https://cpojtnw3.fbxos.fr:18872/')) {
      return new Response(
        JSON.stringify({ success: true, result: { status: 'granted', timeout: 0, challenge: 'ok' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({ success: false, error_code: 'unknown_api_version', msg: "Version d'API inconnue" }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const client = createFreeboxClient(baseSettings);
    const result = await client.checkAuthorization(67);
    assert.equal(result.granted, true);
    assert.equal(result.status, 'granted');
    assert.ok(calls >= 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Freebox openSession gets challenge from /login/ then opens /login/session/', async () => {
  const originalFetch = globalThis.fetch;
  const appToken = 'my-app-token';
  const settings = { ...baseSettings, appToken };
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    const url = String(input);
    if (calls === 1) {
      assert.equal(init?.method, 'GET');
      assert.equal(url, 'http://mafreebox.freebox.fr/api/v4/login/');
      return new Response(
        JSON.stringify({ success: true, result: { logged_in: false, challenge: 'abc123' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (calls === 2) {
      assert.equal(init?.method, 'POST');
      assert.equal(url, 'http://mafreebox.freebox.fr/api/v4/login/session/');
      const body = JSON.parse(String(init?.body ?? '{}')) as { app_id?: string; password?: string };
      assert.equal(body.app_id, 'homelab-manager');
      assert.equal(body.password, createHmac('sha1', appToken).update('abc123').digest('hex'));
      return new Response(
        JSON.stringify({ success: true, result: { session_token: 'sess', challenge: 'c', permissions: {} } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected call ${calls}: ${url}`);
  };

  try {
    const client = createFreeboxClient(settings);
    const token = await client.openSession();
    assert.equal(token, 'sess');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
