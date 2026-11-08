import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFreeboxMetricReport, buildFreeboxNativeChecks } from '../src/freebox.js';

test('buildFreeboxNativeChecks supports newer Freebox payloads without undefined labels', () => {
  const checks = buildFreeboxNativeChecks({
    connection: {
      status: { status: 'showtime', protocol: 'ethernet' },
    } as any,
    system: {
      firmware_version: '4.8.18',
      temp_cpum: 62,
      temp_cpub: 61,
      temp_sw: 52,
    } as any,
    storageDisks: [
      { id: 1, model: 'NVMe 1TB', state: 'enabled' } as any,
    ],
    vms: [
      { id: 'docker-freebox', name: 'docker-freebox', state: 'running' } as any,
    ],
  });

  const summary = checks.map((c) => `${c.key}|${c.label}|${c.reason ?? ''}`).join('\n');
  assert.equal(summary.includes('undefined'), false);

  const connection = checks.find((c) => c.key === 'connection');
  assert.equal(connection?.level, 'ok');

  const firmware = checks.find((c) => c.key === 'firmware');
  assert.equal(firmware?.label, 'Firmware 4.8.18');

  const disk = checks.find((c) => c.key === 'disk:1');
  assert.equal(disk?.label, 'Disque NVMe 1TB');
  assert.equal(disk?.level, 'ok');

  const vm = checks.find((c) => c.key === 'vm:docker-freebox');
  assert.equal(vm?.label, 'VM docker-freebox');
  assert.equal(vm?.level, 'ok');
});

test('buildFreeboxNativeChecks infers connection up from rates when status is absent', () => {
  const checks = buildFreeboxNativeChecks({
    connection: {
      status: { protocol: 'ethernet' },
      down: { rate: 28031 },
      up: { rate: 1022 },
    } as any,
  });

  const connection = checks.find((c) => c.key === 'connection');
  assert.equal(connection?.level, 'ok');
  const rate = checks.find((c) => c.key === 'connection-rate');
  assert.equal(Boolean(rate), true);
});

test('buildFreeboxMetricReport extracts chartable metrics from mixed payloads', () => {
  const report = buildFreeboxMetricReport({
    connection: {
      down: { rate: 28031 },
      up: { rate: 1022 },
    } as any,
    system: {
      temp_cpum: 62,
      temp_cpub: 61,
      temp_sw: 52,
    } as any,
    lanDevices: 14,
    storageDisks: [
      { id: 1, total_bytes: 1000, free_bytes: 250 } as any,
    ],
    vms: [
      { id: 'a', state: 'running' } as any,
      { id: 'b', state: 'stopped' } as any,
    ],
  }, 123);
  assert.equal(report.checkedAt, 123);
  assert.equal(report.tempC, 62);
  assert.equal(report.downRate, 28031);
  assert.equal(report.upRate, 1022);
  assert.equal(report.lanDevices, 14);
  assert.equal(report.vmRunning, 1);
  assert.equal(report.vmTotal, 2);
  assert.equal(report.diskUsedPercent, 75);
});
