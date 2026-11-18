// Observe before dispatch: a click can destroy its own response channel, even
// for same-URL reloads. Never replay a user action to recover that channel.
export async function sendContentAction(browser, tabId, action, data, ensureReady, { graceMs = 200, timeoutMs = 15000 } = {}) {
  const watchesNavigation = action === 'element_click' || action === 'press_key';
  let started = false;
  let complete = false;
  let notify = () => {};
  const onUpdated = (id, change) => {
    if (id !== tabId) return;
    if (change.status === 'loading') { started = true; complete = false; }
    if (started && change.status === 'complete') complete = true;
    notify();
  };
  if (watchesNavigation) browser.tabs.onUpdated.addListener(onUpdated);
  try {
    let response;
    let channelError;
    try {
      response = await new Promise((resolve, reject) => {
        browser.tabs.sendMessage(tabId, { action, data }, (reply) => {
          const error = browser.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(reply);
        });
      });
    } catch (error) { channelError = error; }
    // Only transport loss can be explained by navigation. An explicit page
    // failure must remain a failure, even if another navigation also occurred.
    const closedChannel = channelError && /message (?:port|channel) (?:is )?closed/i.test(channelError.message);
    if (watchesNavigation && (closedChannel || (response?.success && response.data?.success !== false))) {
      if (!started && (closedChannel || Number(data?.wait_after) === 0)) {
        await new Promise((resolve) => setTimeout(resolve, graceMs));
      }
      if (started) {
        if (!complete) await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { notify = () => {}; reject(new Error(`Tab ${tabId}: navigation did not finish within ${timeoutMs}ms`)); }, timeoutMs);
          notify = () => { if (complete) { clearTimeout(timer); notify = () => {}; resolve(); } };
          notify();
        });
        await ensureReady(tabId);
        if (channelError) return { success: true, tab_id: tabId, navigation: true, response_lost: true, key: data?.key || "Enter" };
      }
    }
    if (channelError) throw new Error(`Tab ${tabId}: ${channelError.message}`);
    if (!response?.success) throw new Error(`Tab ${tabId}: ${response?.error || 'Unknown error'}`);
    return response.data;
  } finally {
    if (watchesNavigation) browser.tabs.onUpdated.removeListener(onUpdated);
  }
}
