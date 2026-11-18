import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Isolate the actual batching function without booting the worker or touching
// browser state, settings or the websocket connection.
const source = readFileSync(new URL('../extension/src/background/background.js', import.meta.url), 'utf8');
const batching = source.slice(source.indexOf('const RUN_STEPS_MAX'), source.indexOf('async function executeTool'));
function runner(runTool) {
  const context = vm.createContext({ STEP_TOOLS: ['element_fill', 'page_analyze'], runTool, setTimeout });
  return vm.runInContext(`${batching}\nrunSteps`, context);
}

test('failed action result stops batch and preserves failure details', async () => {
  let calls = 0;
  const run = runner(async () => { calls++; return { success: false, error: 'Fill failed', fields: [] }; });
  const result = await run({ steps: [{ tool: 'element_fill' }, { tool: 'page_analyze' }] });
  assert.equal(result.success, false);
  assert.equal(result.steps_run, 1);
  assert.equal(result.report[0].ok, false);
  assert.equal(result.report[0].error, 'Fill failed');
  assert.equal(result.report[0].result.success, false);
  assert.equal(calls, 1);
});

test('stop_on_error false continues while preserving failed overall status', async () => {
  let calls = 0;
  const run = runner(async () => ++calls === 1 ? { success: false, error: 'Fill failed' } : { title: 'Page' });
  const result = await run({ stop_on_error: false, steps: [{ tool: 'element_fill' }, { tool: 'page_analyze' }] });
  assert.equal(result.success, false);
  assert.equal(result.steps_run, 2);
  assert.equal(result.report[1].ok, true);
});
